//! The checker: Bun's port of TypeScript's checker (`bun_sema`) over files held in memory, on the calling thread. There is
//! no file system, no thread pool and no `bun_sema_driver`. The host gives it every file it may read (the project's
//! configuration, its sources, the packages' declarations and the lib files); a check returns a report as JSON, with
//! positions in UTF-16 code units as TypeScript's API gives them.

use bun_sema::atom::Interner;
use bun_sema::check::explain::MessageChain;
use bun_sema::check::{Program, Requested, compute_ecma_line_starts};
use bun_sema::hir::{self, FileKind};
use bun_sema::json::Json;
use bun_sema::messages::{self, Category};
use bun_sema::program::{FileId, Files, Run};
use bun_sema::resolve::{Host, ModuleDetection, ParseOptions, ScriptKind, typescript_path};
use bun_sema::session::{Arena, Session};
use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::mem::ManuallyDrop;
use std::ptr::NonNull;
use std::rc::Rc;

/// Files by absolute path, in the checker's path format (`/a/b`), and the directories that hold them.
#[derive(Default)]
pub struct MemoryHost {
    files: BTreeMap<Vec<u8>, Vec<u8>>,
    directories: BTreeSet<Vec<u8>>,
}

fn parent(path: &[u8]) -> Option<&[u8]> {
    let at = path.iter().rposition(|&b| b == b'/')?;
    Some(if at == 0 { b"/" } else { &path[..at] })
}

impl MemoryHost {
    /// Adds the file at `path`, or replaces its text.
    pub fn set(&mut self, path: Vec<u8>, text: Vec<u8>) {
        assert!(path.starts_with(b"/"), "a file path is absolute: {}", String::from_utf8_lossy(&path));
        self.files.insert(path, text);
        self.index_directories();
    }

    /// The text of the file at `path`, if there is one.
    pub fn text(&self, path: &[u8]) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice)
    }

    /// Removes the file at `path`, which must be there.
    pub fn remove(&mut self, path: &[u8]) {
        assert!(self.files.remove(path).is_some(), "no file to remove at {}", String::from_utf8_lossy(path));
        self.index_directories();
    }

    fn index_directories(&mut self) {
        self.directories.clear();
        self.directories.insert(b"/".to_vec());

        for path in self.files.keys() {
            let mut at = path.as_slice();

            while let Some(up) = parent(at) {
                if !self.directories.insert(up.to_vec()) {
                    break;
                }
                at = up;
            }
        }
    }
}

impl Host for MemoryHost {
    fn read(&self, path: &[u8]) -> Option<Cow<'static, [u8]>> {
        self.files.get(path).map(|text| Cow::Owned(text.clone()))
    }
    fn is_file(&self, path: &[u8]) -> bool {
        self.files.contains_key(path)
    }
    fn is_dir(&self, path: &[u8]) -> bool {
        self.directories.contains(path)
    }
    fn realpath(&self, path: &[u8]) -> Vec<u8> {
        path.to_vec()
    }
    fn list_dir(&self, path: &[u8]) -> Vec<Vec<u8>> {
        let prefix: Vec<u8> = if path == b"/" { b"/".to_vec() } else { [path, b"/"].concat() };
        let names = self.files.keys().chain(self.directories.iter());
        let names = names.filter_map(|it| it.strip_prefix(prefix.as_slice()));
        let names = names.filter(|rest| !rest.is_empty() && !rest.contains(&b'/'));
        let mut names: Vec<Vec<u8>> = names.map(<[u8]>::to_vec).collect();
        names.sort();
        names.dedup();
        names
    }
    fn script_kind(&self, _: &[u8]) -> Option<ScriptKind> {
        None
    }
    fn extra_file_extensions(&self) -> &[(Vec<u8>, ScriptKind)] {
        &[]
    }
    fn scripts_of_page(&self, _: &[u8]) -> Vec<Vec<u8>> {
        Vec::new()
    }
    fn parse<'s>(&self, arena: &'s Arena, path: &[u8], text: &[u8], atoms: &Interner<'s>, options: ParseOptions) -> hir::File<'s> {
        bun_sema_parser::summarize(
            arena,
            path,
            None,
            text,
            atoms,
            options.experimental_decorators,
            options.module_detection == ModuleDetection::Force,
        )
    }
    /// The project resolves its packages through `paths`, so no `package.json` is read. One that is asked for is
    /// unreadable to the checker, which then resolves as if it had none.
    fn parse_package_json(&self, _: &Arena, path: &[u8]) -> Option<Json> {
        assert!(!self.files.contains_key(path), "the host does not parse package.json files, and {} is one", String::from_utf8_lossy(path));
        None
    }
    fn parallel(&self, count: usize, work: &(dyn Fn(usize) + Sync)) {
        (0..count).for_each(work);
    }
    fn is_of_one_thread(&self) -> bool {
        true
    }
}

/// Positions in one file's text: UTF-8 byte offsets to UTF-16 offsets, and line starts for line and character.
pub(crate) struct Positions<'t> {
    text: &'t [u8],
    starts: Vec<u32>,
}

impl<'t> Positions<'t> {
    pub(crate) fn new(text: &'t [u8]) -> Positions<'t> {
        Positions { text, starts: compute_ecma_line_starts(text) }
    }

    /// The UTF-16 code units of `text[from..to]`: a four-byte sequence is two units, any other is one.
    pub(crate) fn units(&self, from: usize, to: usize) -> usize {
        let bytes = &self.text[from..to];
        bytes.iter().filter(|&&b| b & 0xC0 != 0x80).count() + bytes.iter().filter(|&&b| b >= 0xF0).count()
    }

    /// The byte offset of a line and a character in UTF-16 code units (an LSP position), clamped to the line and the text.
    pub(crate) fn byte_at(&self, line: usize, character: usize) -> usize {
        let Some(&start) = self.starts.get(line) else {
            return self.text.len();
        };
        let end = self.starts.get(line + 1).map_or(self.text.len(), |&next| next as usize);
        let mut at = start as usize;
        let mut units = 0;
        while at < end && units < character {
            let byte = self.text[at];
            // A four-byte sequence is two UTF-16 units; a continuation byte is none.
            units += if byte >= 0xF0 { 2 } else { 1 };
            at += 1;
            while at < end && self.text[at] & 0xC0 == 0x80 {
                at += 1;
            }
        }
        at
    }

    /// `(offset, line, character)` in UTF-16 code units of the byte offset `at`; the line counts from 0.
    pub(crate) fn of(&self, at: u32) -> (usize, usize, usize) {
        let at = (at as usize).min(self.text.len());
        let line = self.starts.partition_point(|&s| s as usize <= at).saturating_sub(1);
        let start = self.starts[line] as usize;
        (self.units(0, at), line, self.units(start, at))
    }
}

/// A JSON string literal of `text`, which is UTF-8: the files are, and so is what the checker writes of them.
pub(crate) fn string(out: &mut String, text: &[u8]) {
    let text = std::str::from_utf8(text).unwrap_or_else(|e| panic!("a message or path is not UTF-8: {e}"));
    out.push('"');

    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `DiagnosticCategory`'s number in TypeScript's API.
fn category(category: Category) -> u32 {
    match category {
        Category::Warning => 0,
        Category::Error => 1,
        Category::Suggestion => 2,
        Category::Message => 3,
    }
}

/// The text of message `code` with its arguments.
fn message_text(code: u32, args: &[Vec<u8>]) -> Vec<u8> {
    let (_, template) = messages::message(code).unwrap_or_else(|| panic!("no message TS{code}"));
    let mut out = Vec::new();
    messages::format(&mut out, template, args);
    out
}

/// A diagnostic of a checked file, as `bun_sema_driver`'s `Diagnostic` keeps what TypeScript sorts by. Offsets are in
/// bytes until the report is written.
struct Diagnostic<'p> {
    file: FileId,
    path: &'p [u8],
    start: u32,
    end: u32,
    code: u32,
    category: Category,
    text: Vec<u8>,
    args: Box<[Box<[u8]>]>,
    message_chain: Vec<MessageChain>,
    related: Vec<Related<'p>>,
}

/// Related information: `'x' is declared here.`
struct Related<'p> {
    at: Option<(FileId, &'p [u8], u32, u32)>,
    code: u32,
    category: Category,
    text: Vec<u8>,
    args: Box<[Box<[u8]>]>,
    message_chain: Vec<MessageChain>,
}

/// What related information is compared by: the file's path, the start and end (or -1), the code, the arguments.
type RelatedKey<'a> = (&'a [u8], i64, i64, u32, &'a [Box<[u8]>]);

impl Related<'_> {
    /// `Loc`: related information without a span has `UndefinedTextRange`, which comes before offset 0.
    fn key(&self) -> RelatedKey<'_> {
        match self.at {
            Some((_, path, start, end)) => (typescript_path(path), i64::from(start), i64::from(end), self.code, &self.args),
            None => (b"", -1, -1, self.code, &self.args),
        }
    }
}

// `SortAndDeduplicateDiagnostics`, as `bun_sema_driver` ports it (`src/sema/driver/lib.rs`, `compare_diagnostics`
// and `sort_and_deduplicate`): `tsc` prints a file's diagnostics in this order, with the related information of
// equal ones merged.

/// `compareMessageChainSize`
fn compare_message_chain_size(c1: &[MessageChain], c2: &[MessageChain]) -> Ordering {
    let by_length = c2.len().cmp(&c1.len());
    c1.iter().zip(c2).fold(by_length, |c, (c1, c2)| c.then_with(|| compare_message_chain_size(&c1.message_chain, &c2.message_chain)))
}

/// `compareMessageChainContent`, of chains of the same size.
fn compare_message_chain_content(c1: &[MessageChain], c2: &[MessageChain]) -> Ordering {
    c1.iter().zip(c2).fold(Ordering::Equal, |c, (c1, c2)| {
        c.then_with(|| c1.args.cmp(&c2.args)).then_with(|| compare_message_chain_content(&c1.message_chain, &c2.message_chain))
    })
}

/// `CompareDiagnostics` of related information, which has none of its own.
fn compare_related(d1: &Related, d2: &Related) -> Ordering {
    d1.key()
        .cmp(&d2.key())
        .then_with(|| compare_message_chain_size(&d1.message_chain, &d2.message_chain))
        .then_with(|| compare_message_chain_content(&d1.message_chain, &d2.message_chain))
}

/// `compareRelatedInfo`
fn compare_related_info(r1: &[Related], r2: &[Related]) -> Ordering {
    let by_length = r2.len().cmp(&r1.len());
    r1.iter().zip(r2).fold(by_length, |c, (d1, d2)| c.then_with(|| compare_related(d1, d2)))
}

/// `CompareDiagnostics`
fn compare_diagnostics(d1: &Diagnostic, d2: &Diagnostic) -> Ordering {
    (typescript_path(d1.path), d1.start, d1.end, d1.code, &d1.args)
        .cmp(&(typescript_path(d2.path), d2.start, d2.end, d2.code, &d2.args))
        .then_with(|| compare_message_chain_size(&d1.message_chain, &d2.message_chain))
        .then_with(|| compare_message_chain_content(&d1.message_chain, &d2.message_chain))
        .then_with(|| compare_related_info(&d1.related, &d2.related))
}

/// `EqualDiagnosticsNoRelatedInfo`
fn equal_without_related(d1: &Diagnostic, d2: &Diagnostic) -> bool {
    (d1.path, d1.start, d1.end, d1.code, &d1.args) == (d2.path, d2.start, d2.end, d2.code, &d2.args) && d1.message_chain == d2.message_chain
}

/// `EqualDiagnostics` of related information.
fn equal_related(d1: &Related, d2: &Related) -> bool {
    d1.key() == d2.key() && d1.message_chain == d2.message_chain
}

/// `SortAndDeduplicateDiagnostics`
fn sort_and_deduplicate(diagnostics: &mut Vec<Diagnostic>) {
    diagnostics.sort_by(compare_diagnostics);
    // `compactAndMergeRelatedInfos`
    diagnostics.dedup_by(|next, first| {
        let is_same = equal_without_related(first, next);

        if is_same {
            first.related.append(&mut next.related);
            first.related.sort_by(compare_related);
            first.related.dedup_by(|next, first| equal_related(first, next));
        }
        is_same
    });
}

/// One diagnostic as JSON (`CheckDiagnostic` in src/protocol.ts): `pos` and `end` in UTF-16 code units,
/// positions with lines and characters from 0, the message with its chain as TypeScript prints it (each level of the
/// chain on its own line, indented by two spaces a level).
fn write_diagnostic(out: &mut String, at: Option<(&[u8], &Positions, u32, u32)>, code: u32, kind: Category, text: &[u8]) {
    if let Some((name, positions, start, end)) = at {
        let (pos, line, character) = positions.of(start);
        let (end, end_line, end_character) = positions.of(end);
        out.push_str("{\"fileName\":");
        string(out, name);
        out.push_str(&format!(
            ",\"pos\":{pos},\"end\":{end},\"startPosition\":{{\"line\":{line},\"character\":{character}}},\
             \"endPosition\":{{\"line\":{end_line},\"character\":{end_character}}},"
        ));
    } else {
        out.push_str("{\"pos\":-1,\"end\":-1,");
    }
    out.push_str(&format!("\"code\":{code},\"category\":{},\"messageText\":", category(kind)));
    string(out, text);
}

fn texts(errors: impl Iterator<Item = (u32, Vec<Vec<u8>>)>) -> Vec<String> {
    errors.map(|(code, args)| String::from_utf8_lossy(&message_text(code, &args)).into_owned()).collect()
}

/// The program of the project whose configuration is `config`, with the lib files in `lib_dir`, in `session`'s arena,
/// and whether the configuration skips checking declaration files.
///
/// The host writes the configuration and gives every file the program reaches, so an error in the configuration or in
/// the program (a missing lib) is a defect of the host, and panics.
pub(crate) fn load<'s>(
    session: &'s Session,
    host: &MemoryHost,
    runs: &mut Runs,
    config: &[u8],
    lib_dir: &[u8],
) -> (&'s Program<'s>, bool, Rc<Shared>) {
    let mut project = match bun_sema::config::load_overriding(host, session, config, &|_| Vec::new()) {
        Ok(project) => project,
        Err(errors) => panic!("the configuration is unreadable: {:?}", texts(errors.into_iter().map(|e| (e.code, e.args)))),
    };
    assert!(project.errors.is_empty(), "configuration errors: {:?}", texts(project.errors.drain(..).map(|e| (e.code, e.args))));
    project.options.lib_dir = lib_dir.to_vec();
    project.options.current_directory = parent(config).unwrap_or(b"/").to_vec();
    project.options.drops_unreferenced = true;
    let skip_lib_check = project.options.skip_lib_check;
    let shared = runs.for_config(config, &project.files);
    // SAFETY: the run lives as long as `shared`, which the caller keeps for as long as it keeps the program.
    let run: &'s Run<'static> = unsafe { &*shared.run() };
    let files = Files::load(session, Some(run), host, project.options, &project.files, &|_| {});
    let problems = files.program_problems();
    assert!(problems.is_empty(), "program errors: {:?}", texts(problems.iter().map(|p| (p.code, p.args.clone()))));
    let files = session.arena().alloc(files);
    (session.arena().alloc(Program::new(session, files)), skip_lib_check, shared)
}

/// What the programs of an instance share for one configuration: every file but the configuration's roots (the
/// generated modules, whose text changes from one check to the next), parsed and bound once (`Run`). The roots are
/// parsed for each program. A run holds while no other file changes (`Runs::forget_for`).
pub struct Shared {
    /// What the run's files are in. It is dropped after the run.
    session: NonNull<Session>,
    run: ManuallyDrop<Run<'static>>,
    roots: Vec<Vec<u8>>,
}

impl Shared {
    fn new(roots: &[Vec<u8>]) -> Shared {
        let session: &'static Session = Box::leak(Box::new(Session::new()));
        // `MemoryHost` is case sensitive, so a root's path is its name (`to_path`).
        let provided = roots.iter().cloned().collect();
        Shared { session: NonNull::from(session), run: ManuallyDrop::new(Run::new(session, provided)), roots: roots.to_vec() }
    }

    /// The run. A program loaded with it keeps this `Shared` for as long as it lives.
    fn run(&self) -> *const Run<'static> {
        &*self.run
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // SAFETY: whatever was loaded with the run keeps this `Shared`, so nothing borrows the run or its session now.
        // The session was leaked from a box by `new`, which nothing else frees.
        unsafe {
            ManuallyDrop::drop(&mut self.run);
            drop(Box::from_raw(self.session.as_ptr()));
        }
    }
}

/// How many configurations' runs an instance keeps. Each holds the parse of every file its program reached that is no root (the lib files,
/// React's declarations, the library's), about 8 MB for a lab; a host that checks lab after lab without an edit between them (an edit
/// forgets the runs of the other configurations, `forget_for`) would otherwise keep them all.
const KEPT_CONFIGURATIONS: usize = 4;

/// The runs of an instance, by the path of their configuration.
#[derive(Default)]
pub struct Runs {
    by_config: BTreeMap<Vec<u8>, Rc<Shared>>,
    /// The configurations in the order they were last used, the latest last.
    used: Vec<Vec<u8>>,
}

impl Runs {
    /// The run for `config`, whose roots are `roots`: a new one if it has none, or had other roots.
    fn for_config(&mut self, config: &[u8], roots: &[Vec<u8>]) -> Rc<Shared> {
        let shared = match self.by_config.get(config) {
            Some(shared) if shared.roots == roots => shared.clone(),
            _ => {
                let shared = Rc::new(Shared::new(roots));
                self.by_config.insert(config.to_vec(), shared.clone());
                shared
            }
        };
        self.used.retain(|used| used != config);
        self.used.push(config.to_vec());
        while self.used.len() > KEPT_CONFIGURATIONS {
            let oldest = self.used.remove(0);
            self.by_config.remove(&oldest);
        }
        shared
    }

    /// Forgets each run that `path` is not a root of: the file it parsed there, or the files it resolved, changed.
    pub fn forget_for(&mut self, path: &[u8]) {
        self.by_config.retain(|_, shared| shared.roots.iter().any(|root| root == path));
        let kept = &self.by_config;
        self.used.retain(|config| kept.contains_key(config));
    }
}

/// Checks the project whose configuration is `config`, with the lib files in `lib_dir`, and reports the
/// diagnostics of its checked files as JSON: `{ "diagnostics": [...], "filesLoaded": n, "incomplete": [paths],
/// "deepestStack": bytes }`, the diagnostics in `tsc`'s order. `incomplete` names the files whose check ran out of
/// the checker's stack budget (`take_ran_out_of_stack`, as the driver reports them): their diagnostics may be
/// missing. `deepestStack` is the most stack in linear memory the check used.
///
/// The host writes the configuration and gives every file the program reaches, so an error in the configuration,
/// in the program (a missing lib) or in a file's references is a defect of the host, and panics.
pub fn check(host: &MemoryHost, runs: &mut Runs, config: &[u8], lib_dir: &[u8]) -> String {
    // Declared before the session, so that it is dropped after it.
    let _shared;
    let session = Session::new();
    let (program, skip_lib_check, shared) = load(&session, host, runs, config, lib_dir);
    _shared = shared;
    let mut checker = program.checker();
    checker.set_requested(Requested::All);
    checker.begin_stack_budget();
    let mut checked = Vec::new();
    let mut incomplete = Vec::new();
    // The project's own sources that were checked: an editor clears the diagnostics of those that have none now.
    let mut sources = Vec::new();

    for i in 0..program.files.modules.len() {
        let module = &program.files.modules[i];
        let wanted = match module.hir.kind {
            FileKind::Json => module.hir.has_parse_diagnostics,
            FileKind::Declaration => !skip_lib_check,
            FileKind::Ts | FileKind::Tsx => true,
        };

        if wanted {
            let file = FileId(i as u32);
            let problems = program.files.include_problems_in(file).map(|(_, _, _, p)| (p.code, p.args.clone()));
            let problems = texts(problems);
            assert!(problems.is_empty(), "reference errors in {}: {problems:?}", String::from_utf8_lossy(module.file_name()));
            checked.push((file, checker.check_file(file)));
            if matches!(module.hir.kind, FileKind::Ts | FileKind::Tsx) {
                sources.push(module.file_name());
            }

            if checker.take_ran_out_of_stack() {
                incomplete.push(module.file_name());
            }
        }
    }
    let deepest_stack = checker.deepest_stack();
    drop(checker);
    let globals = program.global_errors();
    assert!(globals.is_empty(), "global errors: {:?}", texts(globals.into_iter()));
    let name = |file: FileId| program.files.modules[file.idx()].file_name();
    let mut diagnostics = Vec::new();

    for (file, result) in checked {
        for e in program.finish_file(file, result) {
            let related = e.related.into_iter().map(|r| Related {
                at: r.at.map(|(in_file, start, end)| (in_file, name(in_file), start, end)),
                code: r.code,
                category: r.category,
                text: r.text,
                args: r.args,
                message_chain: r.message_chain,
            });
            diagnostics.push(Diagnostic {
                file,
                path: name(file),
                start: e.start,
                end: e.end,
                code: e.code,
                category: e.category,
                text: e.text,
                args: e.args,
                message_chain: e.message_chain,
                related: related.collect(),
            });
        }
    }
    sort_and_deduplicate(&mut diagnostics);
    let mut positions: BTreeMap<FileId, Positions> = BTreeMap::new();

    for d in &diagnostics {
        for file in std::iter::once(d.file).chain(d.related.iter().filter_map(|r| r.at.map(|at| at.0))) {
            positions.entry(file).or_insert_with(|| Positions::new(&program.files.modules[file.idx()].hir.text[..]));
        }
    }
    let mut out = String::from("{\"diagnostics\":[");

    for (i, d) in diagnostics.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_diagnostic(&mut out, Some((d.path, &positions[&d.file], d.start, d.end)), d.code, d.category, &d.text);

        if !d.related.is_empty() {
            out.push_str(",\"relatedInformation\":[");

            for (j, r) in d.related.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                let at = r.at.map(|(file, path, start, end)| (path, &positions[&file], start, end));
                write_diagnostic(&mut out, at, r.code, r.category, &r.text);
                out.push('}');
            }
            out.push(']');
        }
        out.push('}');
    }
    out.push_str(&format!("],\"filesLoaded\":{},\"incomplete\":[", program.files.modules.len()));

    for (i, path) in incomplete.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        string(&mut out, path);
    }
    out.push_str("],\"files\":[");
    for (i, path) in sources.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        string(&mut out, path);
    }
    out.push_str(&format!("],\"deepestStack\":{deepest_stack}}}"));
    out
}

/// Runs `then` with the editor services (`bun_sema::check::services`) of the file at `path`, once the project whose configuration is
/// `config` has been loaded and that file checked, with the file's text. `None` if the program has no such file.
///
/// The program is loaded as a check loads it (the files that are no configuration's roots are shared with the checks, parsed once) and
/// is dropped when `then` returns.
pub(crate) fn with_services_of<R>(
    host: &MemoryHost,
    runs: &mut Runs,
    config: &[u8],
    lib_dir: &[u8],
    path: &[u8],
    then: impl FnOnce(&mut bun_sema::check::services::Services<'_, '_, '_>, FileId, &[u8]) -> R,
) -> Option<R> {
    // Declared before the session, so that it is dropped after it.
    let _shared;
    let session = Session::new();
    let (program, _, shared) = load(&session, host, runs, config, lib_dir);
    _shared = shared;
    let index = program.files.modules.iter().position(|module| module.file_name() == path)?;
    let file = FileId(index as u32);
    let mut checker = program.checker();
    checker.set_requested(Requested::All);
    checker.begin_stack_budget();
    // The services answer about a file that has just been checked.
    checker.check_file(file);
    let text = &program.files.modules[file.idx()].hir.text[..];
    Some(checker.with_services(file, None, |services| then(services, file, text)))
}

/// One loaded program and its checker, for a question about several of its files (where a symbol is referenced): the program is
/// loaded once, and each file is checked when its services are asked for. Nodes (`NodeRef`) keep their meaning across the files'
/// services; symbols (`SymbolRef`) do not.
pub(crate) struct ProgramView<'p, 's> {
    program: &'p Program<'s>,
    checker: bun_sema::check::Checker<'p, 's>,
    lib_prefix: Vec<u8>,
}

impl<'p, 's> ProgramView<'p, 's> {
    /// The file at `path`, if the program has it.
    pub(crate) fn file(&self, path: &[u8]) -> Option<FileId> {
        self.program.files.modules.iter().position(|module| module.file_name() == path).map(|index| FileId(index as u32))
    }

    pub(crate) fn path(&self, file: FileId) -> &'p [u8] {
        self.program.files.modules[file.idx()].file_name()
    }

    /// Whether `file` is one of the lib files: the checker keeps no text of them, so nothing in them has a position.
    pub(crate) fn is_lib(&self, file: FileId) -> bool {
        self.path(file).starts_with(&self.lib_prefix)
    }

    /// Every file of the program that is not a lib file.
    pub(crate) fn project_files(&self) -> Vec<FileId> {
        (0..self.program.files.modules.len() as u32).map(FileId).filter(|&file| !self.is_lib(file)).collect()
    }

    /// Checks `file` and runs `then` with its services and its text.
    pub(crate) fn with_services<R>(
        &mut self,
        file: FileId,
        then: impl FnOnce(&mut bun_sema::check::services::Services<'_, '_, '_>, FileId, &[u8]) -> R,
    ) -> R {
        self.checker.check_file(file);
        let text = &self.program.files.modules[file.idx()].hir.text[..];
        self.checker.with_services(file, None, |services| then(services, file, text))
    }
}

/// Runs `then` with the program of the project whose configuration is `config` (loaded as a check loads it), which is dropped when it
/// returns.
pub(crate) fn with_program<R>(
    host: &MemoryHost,
    runs: &mut Runs,
    config: &[u8],
    lib_dir: &[u8],
    then: impl FnOnce(&mut ProgramView<'_, '_>) -> R,
) -> R {
    // Declared before the session, so that it is dropped after it.
    let _shared;
    let session = Session::new();
    let (program, _, shared) = load(&session, host, runs, config, lib_dir);
    _shared = shared;
    let mut checker = program.checker();
    checker.set_requested(Requested::All);
    checker.begin_stack_budget();
    let mut lib_prefix = lib_dir.to_vec();
    if !lib_prefix.ends_with(b"/") {
        lib_prefix.push(b'/');
    }
    let mut view = ProgramView { program, checker, lib_prefix };
    then(&mut view)
}
