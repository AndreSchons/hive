// No Linux, `hive` passa a ser um lancador e o Electron vira `hive-bin`.
//
// O Electron 44 abre nativo no Wayland e cai com SIGSEGV logo depois do GTK
// (Ubuntu 24.04 com GPU Intel, inclusive com --disable-gpu); pelo XWayland abre
// normal e com o sandbox ligado. A plataforma e escolhida antes de o main rodar
// -- `app.commandLine.appendSwitch` chega tarde --, entao a flag tem que estar
// na linha de comando. O lancador serve igual ao AppImage (o AppRun chama
// `hive`) e ao .deb (`/usr/bin/hive` aponta para `/opt/Hive/hive`).
//
// O perfil do AppArmor do .deb (build/apparmor-profile) aponta para `hive-bin`:
// e o binario que cria o namespace do sandbox, nao o script.
const { chmod, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const launcher = join(context.appOutDir, name);
  await rename(launcher, join(context.appOutDir, `${name}-bin`));
  await writeFile(
    launcher,
    `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
case " $* " in
  *" --ozone-platform"*) exec "$here/${name}-bin" "$@" ;;
esac
exec "$here/${name}-bin" --ozone-platform=x11 "$@"
`,
  );
  await chmod(launcher, 0o755);
};
