"""Stable entrypoint compiled into the FarmOS Flasher tool bundle.

It exposes only upstream esptool's CLI. Release selection, image hashes,
offsets, tickets and enrollment remain server-authorized in the desktop app.
"""

from esptool import main


if __name__ == "__main__":
    main()
