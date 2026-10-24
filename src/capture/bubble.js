// Cast's face bubble on screen (landscape): a round, mirrored camera that floats
// over any app. Drag it and the face moves in the video; the video's own bubble
// is drawn by the engine, so this window is never recorded itself.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

const video = document.getElementById('cam');
const msg = document.getElementById('msg');

const applyZoom = () => {
  const z = Math.min(2.5, Math.max(1, +(localStorage.getItem('facezoom') || 1)));
  video.style.transform = `scale(${-z}, ${z})`;
};
applyZoom();

let camera = null;
let stopped = false;
// The camera goes off the moment Cast is done with this window.
function stopCamera() {
  stopped = true;
  camera?.getTracks().forEach((t) => t.stop());
  camera = null;
  video.srcObject = null;
}
listen('cast-camera-off', stopCamera);
listen('cast-state', (e) => { if (e.payload?.phase === 'idle') stopCamera(); });
window.addEventListener('pagehide', stopCamera);

navigator.mediaDevices
  .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
  .then((stream) => {
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    camera = stream;
    video.srcObject = stream;
  })
  .catch(() => {
    msg.hidden = false;
    msg.textContent = 'Camera blocked. Allow Ghostbar in System Settings › Privacy & Security › Camera.';
  });

document.getElementById('ring').addEventListener('mousedown', (e) => {
  if (e.button === 0) getCurrentWindow().startDragging();
});

listen('bubble-zoom', (e) => {
  localStorage.setItem('facezoom', String(e.payload));
  applyZoom();
});
window.addEventListener('storage', applyZoom);
