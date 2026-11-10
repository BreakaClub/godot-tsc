# Loads the extension in a Godot that has no GodotJS (scripts/verify-load.mjs runs it with `--script`): the class is registered, its
# service thread starts, and it answers a ping and compiles a TypeScript source. What it proves is that this platform's library loads and
# runs in a stock engine; the package's own behaviour is tested through GodotJS (tests/bindings, the demo).
extends SceneTree

const CLASS := "GodotTsc"
const SOURCE_PATH := "/project/main.ts"
const SOURCE := "export const answer: number = 6 * 7;\nexport type Unused = string;\n"
# What the compiled module must hold: the declaration without its type annotation.
const EXPECTED_CODE := "const answer = 6 * 7"
const DEADLINE_MSEC := 20000
const VERIFIED := "godot-tsc loaded:"

var _service: Object
var _waiting := {}
var _replies := {}
var _started := Time.get_ticks_msec()


func _initialize() -> void:
	if not ClassDB.class_exists(CLASS):
		_fail("the extension registered no %s class: the library did not load" % CLASS)
		return
	_service = ClassDB.instantiate(CLASS)
	_waiting[int(_service.request_ping())] = "ping"
	_waiting[int(_service.request_compile(SOURCE_PATH, SOURCE, false))] = "compile"


func _process(_delta: float) -> bool:
	if _service == null:
		return true
	var text: String = _service.poll()
	while not text.is_empty():
		var reply: Variant = JSON.parse_string(text)
		if typeof(reply) != TYPE_DICTIONARY or not _waiting.has(int(reply.get("id", -1))):
			return _fail("poll gave %s" % text)
		_replies[_waiting[int(reply.id)]] = reply
		_waiting.erase(int(reply.id))
		text = _service.poll()
	if not _waiting.is_empty():
		if Time.get_ticks_msec() - _started > DEADLINE_MSEC:
			return _fail("no reply to %s in %d ms; state %s" % [", ".join(_waiting.values()), DEADLINE_MSEC, _service.state()])
		return false
	var compiled: Dictionary = _replies.compile.result
	if not compiled.get("ok", false) or not String(compiled.get("code", "")).contains(EXPECTED_CODE):
		return _fail("the source compiled to %s" % JSON.stringify(compiled))
	var engine := Engine.get_version_info()
	print("%s Godot %s on %s %s, ping %s, compile in %s ms" % [
		VERIFIED, engine.string, OS.get_name(), Engine.get_architecture_name(), JSON.stringify(_replies.ping.result), _replies.compile.ms])
	_service.stop()
	quit(0)
	return true


func _fail(message: String) -> bool:
	printerr("godot-tsc load check failed: %s" % message)
	quit(1)
	return true
