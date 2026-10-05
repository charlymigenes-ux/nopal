#!/usr/bin/env python3
"""Migración única a la identidad estable de máquinas.

Uso (desde la raíz del repo, con el venv de NOPAL):

    python scripts/migrate_machine_identity.py            # simulación: no escribe nada
    python scripts/migrate_machine_identity.py --apply    # escribe, con respaldo previo
    python scripts/migrate_machine_identity.py --apply --esp420

- Detén NOPAL antes de `--apply` (`sudo systemctl stop nopal`): el servidor
  también escribe esos registros.
- La MAC sale del ARP del servidor (solo lectura). Para que las placas por
  red estén en el ARP, conviene que estén encendidas y que NOPAL las haya
  contactado hace poco.
- `--esp420` consulta [ESP420] (solo lectura) a cada placa de red sin
  `chip_id`, como dato complementario de ancla.
- Los respaldos quedan en backups/machine-identity-<fecha>/ (ignorado por git).
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.services import machine_identity_migration  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Migración a la identidad estable de máquinas")
    parser.add_argument("--apply", action="store_true", help="escribir los cambios (con respaldo previo)")
    parser.add_argument("--esp420", action="store_true", help="consultar [ESP420] a las placas de red")
    args = parser.parse_args()

    esp420 = None
    if args.esp420:
        from backend.services.laser_service import _probe_host

        esp420 = lambda host: _probe_host(host, 1.5) or {}  # noqa: E731

    report = machine_identity_migration.migrate(ROOT, apply=args.apply, esp420=esp420)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if not args.apply:
        print("\nSimulación: no se escribió nada. Usa --apply para migrar.", file=sys.stderr)


if __name__ == "__main__":
    main()
