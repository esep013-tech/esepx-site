// ESEP helper: opens a 1C document in the desktop 1C client from esepx.kz cabinet links (esep1c://).
// Double-click = install for the current Windows user (HKCU only). Run with /remove to uninstall.
// It validates the link and runs: 1cestart.exe /url "https://<base>#e1cib/data/...". No logins or passwords are handled here.
var sh = new ActiveXObject('WScript.Shell'), fso = new ActiveXObject('Scripting.FileSystemObject');
var KEY = 'HKCU\\Software\\Classes\\esep1c\\', TITLE = 'ESEP: \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u0432 1\u0421';
function exe() {
  var v = ['%ProgramFiles%', '%ProgramFiles(x86)%', '%ProgramW6432%'];
  for (var i = 0; i < v.length; i++) { var p = sh.ExpandEnvironmentStrings(v[i]) + '\\1cv8\\common\\1cestart.exe'; if (fso.FileExists(p)) return p; }
  return '';
}
function say(t, icon) { sh.Popup(t, 0, TITLE, icon || 64); }
var arg = WScript.Arguments.length ? String(WScript.Arguments(0)) : '';
if (arg === '/remove') {
  try { sh.RegDelete(KEY + 'shell\\open\\command\\'); sh.RegDelete(KEY + 'shell\\open\\'); sh.RegDelete(KEY + 'shell\\'); sh.RegDelete(KEY); } catch (e) {}
  say('\u041f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u0443\u0434\u0430\u043b\u0451\u043d. \u0421\u0441\u044b\u043b\u043a\u0438 \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0432 1\u0421\u00bb \u0441\u043d\u043e\u0432\u0430 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u044e\u0442\u0441\u044f \u0442\u043e\u043b\u044c\u043a\u043e \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435.');
} else if (arg) {
  var u = arg; try { u = decodeURIComponent(u); } catch (e) {}
  var m = /^esep1c:\/\/([a-z0-9.\-]+(?::\d+)?\/[A-Za-z0-9_\-.\/]*?)\/?(?:#(e1cib\/data\/[A-Za-z0-9_.\u0400-\u04FF]+\?ref=[0-9a-f]{32}))?$/i.exec(u);
  var x = exe();
  if (!m) say('\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0435 \u043f\u043e\u0445\u043e\u0436\u0430 \u043d\u0430 \u0441\u0441\u044b\u043b\u043a\u0443 \u043a\u0430\u0431\u0438\u043d\u0435\u0442\u0430 ESEP \u2014 1\u0421 \u043d\u0435 \u0437\u0430\u043f\u0443\u0449\u0435\u043d\u0430.', 48);
  else if (!x) say('\u041f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u0430 1\u0421:\u041f\u0440\u0435\u0434\u043f\u0440\u0438\u044f\u0442\u0438\u0435 \u043d\u0430 \u044d\u0442\u043e\u043c \u043a\u043e\u043c\u043f\u044c\u044e\u0442\u0435\u0440\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430 (\u043d\u0435\u0442 \u0444\u0430\u0439\u043b\u0430 1cestart.exe).', 48);
  else sh.Run('"' + x + '" /url "https://' + m[1] + (m[2] ? '#' + m[2] : '') + '"', 1, false);
} else {
  var dir = sh.ExpandEnvironmentStrings('%LOCALAPPDATA%') + '\\ESEP', dest = dir + '\\esep-open-1c.js';
  try {
    if (!exe()) { say('\u041f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u0430 1\u0421:\u041f\u0440\u0435\u0434\u043f\u0440\u0438\u044f\u0442\u0438\u0435 \u043d\u0430 \u044d\u0442\u043e\u043c \u043a\u043e\u043c\u043f\u044c\u044e\u0442\u0435\u0440\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430. \u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 1\u0421 \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u044d\u0442\u043e\u0442 \u0444\u0430\u0439\u043b \u0435\u0449\u0451 \u0440\u0430\u0437.', 48); WScript.Quit(1); }
    if (!fso.FolderExists(dir)) fso.CreateFolder(dir);
    if (WScript.ScriptFullName.toLowerCase() !== dest.toLowerCase()) fso.CopyFile(WScript.ScriptFullName, dest, true);
    sh.RegWrite(KEY, 'URL:ESEP 1C', 'REG_SZ'); sh.RegWrite(KEY + 'URL Protocol', '', 'REG_SZ');
    sh.RegWrite(KEY + 'shell\\open\\command\\', 'wscript.exe "' + dest + '" "%1"', 'REG_SZ');
    say('\u0413\u043e\u0442\u043e\u0432\u043e. \u0422\u0435\u043f\u0435\u0440\u044c \u0432 \u043a\u0430\u0431\u0438\u043d\u0435\u0442\u0435 ESEP \u0437\u043d\u0430\u0447\u043e\u043a \u2197 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442 \u0432 \u043f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u0435 1\u0421 \u043d\u0430 \u044d\u0442\u043e\u043c \u043a\u043e\u043c\u043f\u044c\u044e\u0442\u0435\u0440\u0435.\n\n\u041f\u0440\u0438 \u043f\u0435\u0440\u0432\u043e\u043c \u043d\u0430\u0436\u0430\u0442\u0438\u0438 \u0431\u0440\u0430\u0443\u0437\u0435\u0440 \u0441\u043f\u0440\u043e\u0441\u0438\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u0435 \u2014 \u043e\u0442\u043c\u0435\u0442\u044c\u0442\u0435 \u00ab\u0412\u0441\u0435\u0433\u0434\u0430 \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0442\u044c\u00bb \u0438 \u043d\u0430\u0436\u043c\u0438\u0442\u0435 \u00ab\u041e\u0442\u043a\u0440\u044b\u0442\u044c\u00bb.');
  } catch (e) { say('\u041d\u0435 \u043f\u043e\u043b\u0443\u0447\u0438\u043b\u043e\u0441\u044c \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c: ' + e.message, 16); }
}
