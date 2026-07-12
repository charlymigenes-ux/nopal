import logging
import os

# Logging — pensado para el mismo nivel de compromiso que los logs de
# Moonraker/Klipper: archivo persistente con rotación, no solo consola.
LOG_DIR = "logs"
LOG_FILE = os.path.join(LOG_DIR, "nopal.log")
LOG_LEVEL = logging.INFO  # DEBUG solo para diagnóstico activo, no se deja prendido
LOG_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
LOG_BACKUP_COUNT = 5  # nopal.log, nopal.log.1 ... nopal.log.5
LOG_FORMAT = "%(asctime)s %(levelname)-8s [%(name)s] %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
