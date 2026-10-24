// Draws Gus Assistant's ghost: the app icon and the menu bar glyphs, as SVG.
// node design/make_icons.cjs, then render the SVGs to PNG (any renderer; headless Chrome was used):
//   design/icon.svg -> design/icon-1024.png -> bun run tauri icon design/icon-1024.png
//   design/tray/*.svg -> 64 px PNGs in src-tauri/resources/tray_*.png (template images)

function ghostPath(cx, top, w, h, scallops = 3) {
  const r = w / 2, left = cx - r, right = cx + r, hem = top + h, headY = top + r;
  const s = w / scallops, a = s / 2;
  let d = `M${left} ${hem} V${headY} A${r} ${r} 0 0 1 ${right} ${headY} V${hem}`;
  for (let i = 0; i < scallops; i++) d += ` a${a} ${a * 0.8} 0 0 1 ${-s} 0`;
  return d + 'Z';
}
const path = require('path');
const fs = require('fs');
// App icon, 1024: Overload's tile, slate capture corners, teal ghost, orange record light.
const g = ghostPath(512, 286, 360, 430);
const corner = (x, y, dx, dy) => `M${x} ${y + dy * 92} V${y} H${x + dx * 92}`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17302E"/><stop offset="1" stop-color="#0E1C1B"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#tile)"/>
  <g fill="none" stroke="#4B6A96" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
    <path d="${corner(222, 222, 1, 1)}"/><path d="${corner(802, 222, -1, 1)}"/>
    <path d="${corner(222, 802, 1, -1)}"/><path d="${corner(802, 802, -1, -1)}"/>
  </g>
  <path d="${g}" fill="#50C1B1"/>
  <ellipse cx="456" cy="470" rx="30" ry="42" fill="#0E1C1B"/>
  <ellipse cx="568" cy="470" rx="30" ry="42" fill="#0E1C1B"/>
  <circle cx="676" cy="318" r="40" fill="#EE8A50" stroke="#122624" stroke-width="16"/>
</svg>`;
fs.writeFileSync(path.join(__dirname, 'icon.svg'), icon);
// Menu bar glyphs (template: black on clear), 64 px canvas.
const tg = ghostPath(32, 8, 36, 46);
const eyes = (y = 27) => `<ellipse cx="26.5" cy="${y}" rx="3.4" ry="4.6" fill="#000"/><ellipse cx="37.5" cy="${y}" rx="3.4" ry="4.6" fill="#000"/>`;
const tray = (extra = '', mask = eyes()) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><mask id="m"><rect width="64" height="64" fill="#fff"/>${mask.replace(/#000/g, '#000')}</mask></defs>
  <path d="${tg}" fill="#000" mask="url(#m)"/>${extra}</svg>`;
fs.writeFileSync(path.join(__dirname, 'tray', 'tray_idle.svg'), tray());
// recording: the record light on
fs.writeFileSync(path.join(__dirname, 'tray', 'tray_recording.svg'), tray('<circle cx="51" cy="13" r="8" fill="#000" stroke="#fff" stroke-width="0"/>', eyes() + '<circle cx="51" cy="13" r="11" fill="#000"/>'));
// transcribing: three dots under the eyes
fs.writeFileSync(path.join(__dirname, 'tray', 'tray_transcribing.svg'), tray('', eyes(24) + '<circle cx="24.5" cy="37" r="2.6" fill="#000"/><circle cx="32" cy="37" r="2.6" fill="#000"/><circle cx="39.5" cy="37" r="2.6" fill="#000"/>'));
// warning: a small badge with a bar
fs.writeFileSync(path.join(__dirname, 'tray', 'tray_warning.svg'), tray('<circle cx="51" cy="13" r="9" fill="#000"/><rect x="49.6" y="7" width="2.8" height="8" rx="1.4" fill="#fff"/><circle cx="51" cy="18.4" r="1.6" fill="#fff"/>', eyes() + '<circle cx="51" cy="13" r="12" fill="#000"/>'));
