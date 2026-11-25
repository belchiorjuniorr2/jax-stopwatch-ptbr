"""Start/stop only this project's services; never replace other localhost apps."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("JAX_HOME") or ROOT).expanduser() / "runtime"  # see bridge.py
URL = "http://127.0.0.1:18765"


def health():
    try:
        data = json.load(urllib.request.urlopen(URL + "/api/state", timeout=1))
        if data.get("service") == "stopwatch-mac-bridge":
            return data
        raise RuntimeError("A porta 18765 está em uso por outro serviço; não alterei esse serviço")
    except (OSError, ValueError):
        return None


def start():
    if health():
        print("A ponte do StopWatch já está no ar: " + URL)
        return
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        raise RuntimeError("Falta o ambiente Python. No diretório do projeto, rode uv sync")
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (RUNTIME / "bridge.log").open("ab") as log:
        child = subprocess.Popen([str(python), str(ROOT / "src/bridge.py")], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(40):
        if health():
            print("A ponte do StopWatch foi iniciada: " + URL)
            print("No relógio: segure o A para falar e solte para enviar. O B troca o assistente; toque duas vezes no B para parar.")
            return
        if child.poll() is not None:
            raise RuntimeError("A ponte não iniciou. Veja runtime/bridge.log")
        time.sleep(.25)
    raise RuntimeError("A ponte demorou demais para iniciar. Veja runtime/bridge.log")


def run():
    """Foreground entry for the login agent: exit 0 if already running (started by hand)."""
    if health():
        print("A ponte do StopWatch já está no ar; o item de login não inicia outra vez")
        return
    os.chdir(ROOT)
    os.execv(str(ROOT / ".venv/bin/python"), [str(ROOT / ".venv/bin/python"), str(ROOT / "src/bridge.py")])


LABEL = "io.github.jax-stopwatch.bridge"
AGENT = Path.home() / f"Library/LaunchAgents/{LABEL}.plist"


def autostart(enable):
    """Login agent: starts the bridge at login, restarts it after a crash, never after a clean stop."""
    import plistlib
    domain = f"gui/{os.getuid()}"
    subprocess.run(["/bin/launchctl", "bootout", domain, str(AGENT)], capture_output=True)
    if not enable:
        AGENT.unlink(missing_ok=True)
        print("A inicialização automática foi desligada")
        return
    # Keep the session's PATH so tools installed via nvm, npm prefixes etc. (codex, cloudflared) resolve.
    base = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    path = ":".join(p for p in dict.fromkeys((os.environ.get("PATH", "") + ":" + base).split(":")) if p)
    env = {"PATH": path, "HOME": str(Path.home()), "LANG": "pt_BR.UTF-8"}
    # Carry the session's proxy and data-folder settings, if any, into the login agent.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "JAX_HOME", "JAX_WORKSPACE", "JAX_AVATARS"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    AGENT.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [str(ROOT / ".venv/bin/python"), str(ROOT / "src/manage.py"), "run"],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": env,
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "ProcessType": "Interactive",
        "StandardOutPath": str(RUNTIME / "bridge.log"),
        "StandardErrorPath": str(RUNTIME / "bridge.log"),
    }))
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(AGENT)], check=True)
    print("Inicialização automática ligada: roda ao entrar na conta, reinicia se cair, e não volta se você parar na mão")


def stop():
    data = health()
    if not data:
        print("A ponte do StopWatch não está rodando")
        return
    pid = int(data["pid"])
    command = subprocess.check_output(["/bin/ps", "-p", str(pid), "-o", "command="], text=True)
    if "bridge.py" not in command:
        raise RuntimeError("O processo não é o esperado; não interrompi")
    os.kill(pid, signal.SIGTERM)
    for _ in range(40):
        if not health():
            print("A ponte do StopWatch foi interrompida")
            return
        time.sleep(.25)
    raise RuntimeError("A interrupção ainda não terminou. Confira o log da ponte")


if __name__ == "__main__":
    os.umask(0o077)
    action = sys.argv[1] if len(sys.argv) > 1 else "start"
    if action == "start":
        start()
    elif action == "stop":
        stop()
    elif action == "run":
        run()
    elif action == "autostart":
        autostart((sys.argv[2] if len(sys.argv) > 2 else "on") != "off")
    elif action == "status":
        data = health()
        print(json.dumps({k: data.get(k) for k in ["connected", "phase", "codexReady", "grokConfigured"]}, ensure_ascii=False) if data else "parado")
    else:
        raise SystemExit("Usage: manage.py start|stop|status|run|autostart [on|off]")
