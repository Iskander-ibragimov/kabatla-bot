# voice-sample diagnostics

Run: 2026-10-03T17:38:02Z

## Steps
- install piper+gdown: success
- download models: success
- send sample: success

## Versions
- ffmpeg: ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
- piper-tts: Version: 1.8.0
- piper binary: /home/runner/work/_temp/venv/bin/piper
- gdown: gdown 6.4.1 at /home/runner/work/_temp/venv/lib/python3.12/site-packages

## Model files (models/)
```
female/config.json  6838 bytes
female/female.onnx  113800453 bytes
female/female.onnx.json  6838 bytes
male/config.json  6838 bytes
male/male.onnx  113800453 bytes
male/male.onnx.json  6838 bytes
```

## model download log (tail)
```
  espeak-ng-data/ru_dict
  espeak-ng-data/sd_dict
  espeak-ng-data/shn_dict
  espeak-ng-data/si_dict
  espeak-ng-data/sjn_dict
  espeak-ng-data/sk_dict
  espeak-ng-data/sl_dict
  espeak-ng-data/smj_dict
  espeak-ng-data/sq_dict
  espeak-ng-data/sr_dict
  espeak-ng-data/sv_dict
  espeak-ng-data/sw_dict
  espeak-ng-data/ta_dict
  espeak-ng-data/te_dict
  espeak-ng-data/th_dict
  espeak-ng-data/tk_dict
  espeak-ng-data/tn_dict
  espeak-ng-data/tr_dict
  espeak-ng-data/tt_dict
  espeak-ng-data/ug_dict
  espeak-ng-data/uk_dict
  espeak-ng-data/ur_dict
  espeak-ng-data/uz_dict
  espeak-ng-data/vi_dict
  espeak-ng-data/yue_dict
  female/config.json
  female/female.ckpt
  female/female.onnx
  male/config.json
  male/male.ckpt
  male/male.onnx
  libespeak-ng.so
  libespeak-ng.so.1
  libespeak-ng.so.1.1.51
  libonnxruntime.so.1.14.1
  piper
downloading female/config.json
downloading female/female.onnx
downloading male/config.json
downloading male/male.onnx
```

## Sample run

Piper voices selected: piper:female <- female.onnx; piper:male <- male.onnx

| voice | synthesized | sent | total | first error |
|---|---|---|---|---|
| api:alsu | 20 | 20 | 20 |  |
| api:almaz | 20 | 20 | 20 |  |
| piper:female | 0 | 0 | 20 | piper exited with 1: ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   File "/usr/lib/python3.12/enum.py", line 757, in __call__     return cls.__new__(cls, value)            ^^^^^^^^^^^^^^^^^^^^^^^   File "/usr/lib/python3.12/enum.py", line 1171, in __new__     raise ve_exc ValueError: 'PhonemeType.ESPEAK' is not a valid PhonemeType |
| piper:male | 0 | 0 | 20 | piper exited with 1: ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   File "/usr/lib/python3.12/enum.py", line 757, in __call__     return cls.__new__(cls, value)            ^^^^^^^^^^^^^^^^^^^^^^^   File "/usr/lib/python3.12/enum.py", line 1171, in __new__     raise ve_exc ValueError: 'PhonemeType.ESPEAK' is not a valid PhonemeType |

Summary message: sent.
