"""
One-time conversion of an image restoration / upscaling model (1x cleanup or Nx upscale) from a ComfyUI-style .pth file to ONNX, for the Token Framer App.

Needs a Python with torch, spandrel and onnx. ComfyUI's bundled Python has all three, and ComfyUI itself does NOT have to be running:

  E:\\SwarmUI\\dlbackend\\comfy\\python_embeded\\python.exe tools\\convert-model.py "<path>\\4x-UltraSharp.pth" models\\4x-UltraSharp.onnx

The ONNX model takes an RGB float image in 0..1, shape (1, 3, H, W), and returns (1, 3, H*scale, W*scale). H and W must satisfy the model's size rules
(the app pads to them). Those rules and the scale are written to a small <name>.json next to the .onnx, which the app reads.
After exporting it runs a check against the original PyTorch model and prints the largest difference (it should be tiny).
"""
import json
import os
import sys

import numpy as np
import torch
import spandrel


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    desc = spandrel.ModelLoader().load_from_file(src)
    req = desc.size_requirements
    multiple, minimum = req.multiple_of, req.minimum
    print(f"architecture {desc.architecture.name}, scale {desc.scale}, {desc.input_channels} -> {desc.output_channels} channels, size requirements {req}")
    if desc.input_channels != 3 or desc.output_channels != 3 or req.square:
        sys.exit("This script is for RGB-in, RGB-out models without a square-size requirement.")
    model = desc.model.eval().float().cpu()
    scale = int(desc.scale)

    ceil = lambda x: x if x % multiple == 0 else (x // multiple + 1) * multiple
    dummy = torch.rand(1, 3, ceil(max(64, minimum)), ceil(max(96, minimum)))
    torch.onnx.export(
        model, dummy, dst, opset_version=17, input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "h", 3: "w"}}, dynamo=False,
    )
    print("wrote", dst)

    import onnxruntime as ort
    sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
    worst = 0.0
    for h, w in [(64, 96), (128, 80), (200, 332)]:
        h, w = ceil(max(h, minimum)), ceil(max(w, minimum))
        x = torch.rand(1, 3, h, w)
        with torch.no_grad():
            ref = model(x).clamp(0, 1).numpy()
        got = np.clip(sess.run(None, {"input": x.numpy()})[0], 0, 1)
        if ref.shape != got.shape or got.shape[2] != h * scale:
            sys.exit(f"output shape {got.shape} differs from PyTorch {ref.shape} at input {h}x{w}: the model does not export with dynamic sizes")
        worst = max(worst, float(np.abs(ref - got).max()))
    print(f"largest difference against PyTorch over 3 sizes: {worst:.2e}")
    if worst > 1e-3:
        sys.exit("The ONNX output does not match PyTorch closely enough; not keeping this conversion.")

    meta = {"architecture": desc.architecture.name, "scale": scale, "multiple": multiple, "minimum": minimum, "source": os.path.basename(src)}
    with open(os.path.splitext(dst)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print("wrote", os.path.splitext(dst)[0] + ".json", meta)


if __name__ == "__main__":
    main()
