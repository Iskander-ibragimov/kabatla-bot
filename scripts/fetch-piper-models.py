"""Downloads only the Piper voice files (*.onnx and *.json) of the TatarTTS Google Drive folder into models/.
The folder also holds multi-hundred-MB training checkpoints that the sample does not need. Run only in GitHub Actions."""
import os
import sys

import gdown

FOLDER = "https://drive.google.com/drive/folders/1YmtDVYLVogEfw3SE7GUl0LHZaIojAeap"
OUT = "models"

files = gdown.download_folder(url=FOLDER, output=OUT, quiet=True, skip_download=True, use_cookies=False)
if not files:
    sys.exit("gdown listed no files in the folder")
print("folder listing:", flush=True)
for f in files:
    print(f"  {f.path}", flush=True)
wanted = [f for f in files if f.path.endswith((".onnx", ".json"))]
if not any(f.path.endswith(".onnx") for f in wanted):
    sys.exit("no .onnx files in the folder listing")
for f in wanted:
    os.makedirs(os.path.dirname(f.local_path), exist_ok=True)
    print(f"downloading {f.path}", flush=True)
    if not gdown.download(id=f.id, output=f.local_path, quiet=True):
        sys.exit(f"download failed: {f.path}")
