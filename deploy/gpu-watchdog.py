import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

IMDS = "http://169.254.169.254/metadata"
ARM = "https://management.azure.com"
ARM_API = "2024-07-01"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def get_json(url: str, headers: dict | None = None, timeout: float = 5) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def busy_queues(health: dict) -> int:
    total = 0
    for counts in (health.get("queues") or {}).values():
        total += sum(int(counts.get(k) or 0) for k in ("waiting", "active", "delayed"))
    return total


def decide(health: dict | None, uptime_s: float, now: float, idle_min: int, max_hours: int) -> tuple[bool, str]:
    if max_hours > 0 and uptime_s >= max_hours * 3600:
        return True, f"ligada há {uptime_s / 3600:.1f} h (limite {max_hours} h)"
    if uptime_s < idle_min * 60:
        return False, f"ligada há {uptime_s / 60:.0f} min, menos que {idle_min} min"
    if health is None:
        return True, f"API sem resposta e ligada há {uptime_s / 60:.0f} min"
    busy = busy_queues(health)
    if busy:
        return False, f"{busy} jobs nas filas"
    last = health.get("lastJobAt")
    if last:
        idle_s = now - datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp()
        if idle_s < idle_min * 60:
            return False, f"último job há {idle_s / 60:.0f} min, menos que {idle_min} min"
        return True, f"sem jobs há {idle_s / 60:.0f} min (limite {idle_min} min)"
    return True, f"nenhum job desde que ligou ({uptime_s / 60:.0f} min)"


def system_uptime() -> float:
    with open("/proc/uptime", encoding="ascii") as f:
        return float(f.read().split()[0])


def deallocate(compute: dict) -> int:
    token = get_json(
        f"{IMDS}/identity/oauth2/token?api-version=2018-02-01&resource={ARM}/",
        {"Metadata": "true"},
    )["access_token"]
    url = (
        f"{ARM}/subscriptions/{compute['subscriptionId']}/resourceGroups/{compute['resourceGroupName']}"
        f"/providers/Microsoft.Compute/virtualMachines/{compute['name']}/deallocate?api-version={ARM_API}"
    )
    req = urllib.request.Request(url, data=b"", method="POST", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.status


def main() -> int:
    if os.environ.get("WATCHDOG_ENABLED", "true").lower() in ("0", "false", "no"):
        print("watchdog desligado (WATCHDOG_ENABLED)")
        return 0
    idle_min = env_int("WATCHDOG_IDLE_MINUTES", 60)
    max_hours = env_int("WATCHDOG_MAX_HOURS", 12)
    dry_run = os.environ.get("WATCHDOG_DRY_RUN", "").lower() in ("1", "true", "yes")
    try:
        compute = get_json(f"{IMDS}/instance/compute?api-version=2021-02-01", {"Metadata": "true"}, timeout=2)
    except (urllib.error.URLError, OSError, ValueError):
        print("fora da Azure (IMDS sem resposta): nada a fazer")
        return 0
    port = env_int("API_PORT", 8000)
    try:
        health = get_json(f"http://127.0.0.1:{port}/health", timeout=10)
    except urllib.error.HTTPError as err:
        health = json.loads(err.read().decode("utf-8") or "null")
    except (urllib.error.URLError, OSError, ValueError):
        health = None
    stop, reason = decide(health, system_uptime(), time.time(), idle_min, max_hours)
    if not stop:
        print(f"mantém ligada: {reason}")
        return 0
    if dry_run:
        print(f"desalocaria agora (WATCHDOG_DRY_RUN): {reason}")
        return 0
    print(f"desalocando {compute['name']}: {reason}", flush=True)
    status = deallocate(compute)
    print(f"Azure aceitou o pedido (HTTP {status})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
