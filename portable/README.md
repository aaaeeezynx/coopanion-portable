# Coopanion Portable

This directory contains a cross-platform portable launcher for
[Coopanion](https://github.com/Pal-AI-Lab/Coopanion). It is maintained in
[aaaeeezynx/coopanion-portable](https://github.com/aaaeeezynx/coopanion-portable),
a fork that preserves the upstream Git history.

The portable tools are an integration layer around the upstream application.
They do not vendor or redistribute the upstream release binaries. At
installation time, the scripts download an official upstream release and
verify its SHA-256 checksum.

## Supported platforms

| Platform | Architecture | Installer |
| --- | --- | --- |
| Windows 10/11 | x64 | `Install-Coopanion-Windows.cmd` |
| macOS | Apple Silicon (arm64) | `Install-Coopanion-macOS.command` |
| Linux | x64 | `Install-Coopanion-Linux.sh` |

The portable directory must be writable. Git is required on macOS and Linux.
Windows prefers the Git bundled with Coopanion when it is available.

## Install

On a new machine, clone this fork and enter the portable directory:

```text
git clone https://github.com/aaaeeezynx/coopanion-portable.git
cd coopanion-portable/portable
```

Then run the installer for the machine:

Windows:

```powershell
.\Install-Coopanion-Windows.cmd
```

macOS:

```bash
bash "Install-Coopanion-macOS.command"
```

Linux:

```bash
bash "Install-Coopanion-Linux.sh"
```

Re-run an installer with `--force` or `-Force` to replace the installed
application. Previous Windows and macOS installations are moved into a local
backup directory. Linux keeps timestamped AppImage backups.

## Start

Use the launcher rather than opening the application executable directly. The
launcher checks the profile repository, synchronizes changes, applies the
OpenCodeGo compatibility setting, and then starts Coopanion.

- Windows: `Start-Coopanion.cmd`
- macOS: double-click `Start Coopanion.command`
- Linux: `bash "Start-Coopanion-Linux.sh"`

On first launch, if `profile/` does not exist, it is cloned from:

```text
https://github.com/aaaeeezynx/coopanion-profile.git
```

GitHub authentication may be requested when that repository is private.

## What is synchronized

The sync tool uses an allowlist. It synchronizes:

- Shared companion, persona-related, language, theme, desktop-pet, touch, and
  speech-recognition settings that are safe to share across machines.
- Markdown and plain-text memory/persona files under the companion workspace.
- `avatar.png`.

The following stay local and are deliberately excluded:

- API keys, provider `.env` files, authentication data, and secrets.
- Provider configuration, local paths, permissions, window position, caches,
  logs, databases, extensions, models, and blobs.
- Application binaries and downloaded release archives.
- All files outside the explicit profile allowlist.

The sync runner performs a privacy scan before committing and stops if it finds
patterns resembling common credentials or private keys.

## Synchronization behavior

Synchronization occurs:

- At launcher startup.
- Every few seconds while Coopanion is running when managed files change.
- When Coopanion exits.

The profile repository is nested at `profile/` and is ignored by this parent
repository. Local and remote histories are never force-pushed. If both devices
change the same content and Git cannot rebase cleanly, synchronization stops,
keeps the local changes and creates a backup under `data/.portable-sync/`.

The latest result is written to `data/.portable-sync/status.json`; detailed
history is in `data/.portable-sync/sync.log`. Both paths are relative to this
portable directory.

## OpenCodeGo compatibility

The current upstream `coo` provider does not expose arbitrary HTTP headers.
OpenCodeGo requires a stable `x-opencode-session` request header, so this fork
includes a portable wrapper workaround:

1. An existing OpenCode provider config is preserved.
2. Its kind is changed to `openai-responses-compat`.
3. Existing options and headers are retained.
4. `x-opencode-session` is set to a stable platform identifier.

The migration runs during installation and every launch. Existing provider
credentials are never read or modified by the migration script. On a brand-new
machine, configure the OpenCode provider once, then restart Coopanion so the
compatibility migration can be applied.

This is not yet a native upstream feature. The fork documents the workaround
and tracks a proposed upstream implementation separately.

## Privacy

The profile repository is intended for personal memory and shareable settings,
not secrets. Keep the profile repository private unless every synchronized file
is safe to publish. Review `profile/` before pushing profile changes and never
put API keys, tokens, private keys, or machine credentials in memory files.

The portable `.gitignore` excludes `app/`, `data/`, `_downloads/`, `profile/`,
`.tmp/`, environment files, common credential files, and operating-system
metadata. See `.gitignore` for the complete list.

## License

The upstream project and these portable integration changes are distributed
under the GNU Affero General Public License, version 3 or later. See the
repository root `LICENSE` and `portable/NOTICE.md`.
