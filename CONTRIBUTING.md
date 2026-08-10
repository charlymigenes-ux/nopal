# Contributing to NOPAL

Thanks for considering a contribution — NOPAL grows through people testing it on real hardware, reporting what breaks, and sending fixes.

## Ways to contribute

- **Report a bug**: open an [issue](https://github.com/charlymigenes-ux/nopal/issues/new) with your OS, Python version, the machine/firmware involved, and steps to reproduce.
- **Suggest a feature**: open an issue describing the problem it solves, not just the feature itself.
- **Register hardware for testing**: if you have a printer, laser, CNC, or board NOPAL doesn't support yet, register it at [charlymigenes-ux.github.io/nopal/colabora](https://charlymigenes-ux.github.io/nopal/colabora/).
- **Send a pull request**: fixes, new machine drivers, plugin improvements, docs, translations.

## Development setup

```bash
git clone https://github.com/charlymigenes-ux/nopal.git
cd nopal
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

## Pull requests

1. Fork the repo and create a branch from `main` (e.g. `fix/laser-jog-offset`, `feat/flashforge-driver`).
2. Keep the change focused — one fix or feature per PR is easier to review than several bundled together.
3. Make sure `pytest` passes locally.
4. Describe **what** changed and **why** in the PR description; link the issue it addresses if there is one.
5. A maintainer will review and may ask for changes before merging.

## Code style

Match the conventions already used in the file you're editing — driver modules follow the same shape per machine brand, and the frontend follows the existing theme system. When in doubt, prefer consistency with neighboring code over introducing a new pattern.

## License

By contributing, you agree that your contributions will be licensed under the project's [GPLv3 license](./LICENSE).
