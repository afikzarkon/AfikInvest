import React, { useCallback, useRef, useState } from 'react';
import Cropper from 'react-easy-crop';
import Avatar from '../ui/Avatar';
import { putAccount, deleteAccount } from '../../accountApi';
import { useToast } from '../ui/Toast';

// Upload, crop and delete the profile picture.
//
// The crop happens here: the chosen image is drawn into a 256x256 canvas
// and re-encoded as JPEG, so what is uploaded is small, square, and free of
// the original's metadata (location, camera); the server only checks it.
const OUTPUT_SIZE = 256;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function cropToDataUrl(src, area) {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function AvatarEditor({ avatar, name, onChange }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [source, setSource] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState(null);
  const [busy, setBusy] = useState(false);

  const onCropComplete = useCallback((_, pixels) => setArea(pixels), []);

  const pick = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.type)) {
      toast.error('יש לבחור קובץ תמונה (JPG, PNG או WebP)');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      toast.error('התמונה גדולה מדי (עד 10MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSource(reader.result);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!area) return;
    setBusy(true);
    try {
      const dataUrl = await cropToDataUrl(source, area);
      const r = await putAccount('/api/account/avatar', { dataUrl });
      if (!r.ok) {
        toast.error(r.data.error || 'שמירת התמונה נכשלה');
        return;
      }
      onChange(dataUrl);
      setSource(null);
      toast.success('תמונת הפרופיל עודכנה');
    } catch {
      toast.error('לא ניתן היה לעבד את התמונה');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    const r = await deleteAccount('/api/account/avatar');
    setBusy(false);
    if (!r.ok) {
      toast.error(r.data.error || 'המחיקה נכשלה');
      return;
    }
    onChange(null);
    toast.success('תמונת הפרופיל נמחקה');
  };

  return (
    <div className="avatar-editor">
      <Avatar src={avatar} name={name} size={88} />
      <div className="avatar-editor-actions">
        <input ref={fileRef} type="file" accept="image/*" className="visually-hidden" onChange={pick} tabIndex={-1} aria-hidden="true" />
        <button type="button" className="settings-button" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
          {avatar ? 'החלפת תמונה' : 'העלאת תמונה'}
        </button>
        {avatar ? (
          <button type="button" className="settings-button is-quiet" onClick={remove} disabled={busy}>
            מחיקת התמונה
          </button>
        ) : null}
      </div>

      {source ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="crop-title">
          <div className="modal-card crop-modal">
            <h3 id="crop-title" className="settings-card-title">
              חיתוך התמונה
            </h3>
            <div className="crop-area">
              <Cropper image={source} crop={crop} zoom={zoom} aspect={1} cropShape="round" showGrid={false} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={onCropComplete} />
            </div>
            <label className="auth-label" htmlFor="crop-zoom">
              הגדלה
            </label>
            <input id="crop-zoom" type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="crop-zoom" />
            <div className="settings-actions">
              <button type="button" className="auth-submit" onClick={save} disabled={busy || !area}>
                {busy ? 'שומר…' : 'שמירה'}
              </button>
              <button type="button" className="auth-link" onClick={() => setSource(null)} disabled={busy}>
                ביטול
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AvatarEditor;
