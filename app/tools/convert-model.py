"""
One-time conversion of a same-size (1x) image restoration model from a ComfyUI-style .pth file to ONNX, for the Token Framer App.

Needs a Python with torch, spandrel and onnx. ComfyUI's bundled Python has all three, and ComfyUI itself does NOT have to be running:

  E:\\SwarmUI\\dlbackend\\comfy\\python_embeded\\python.exe tools\\convert-model.py "<path>\\1x_PureVision.pth" models\\1x_PureVision.onnx

The ONNX model takes an RGB float image in 0..1, shape (1, 3, H, W) with H and W multiples of 4 (the app pads), and returns the same shape.
After exporting it runs a quick check against the original PyTorch model and prints the largest difference (it should be tiny).
"""
import sys

import numpy as np
import torch
import spandrel


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    desc = spandrel.ModelLoader().load_from_file(src)
    print(f"architecture {desc.architecture.name}, scale {desc.scale}, {desc.input_channels} -> {desc.output_channels} channels, size requirements {desc.size_requirements}")
    if desc.scale != 1:
        sys.exit("This script is for 1x models (same-size output).")
    model = desc.model.eval().float().cpu()

    dummy = torch.rand(1, desc.input_channels, 64, 96)
    torch.onnx.export(
        model, dummy, dst, opset_version=17, input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "h", 3: "w"}}, dynamo=False,
    )
    print("wrote", dst)

    import onnxruntime as ort
    sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
    worst = 0.0
    for h, w in [(64, 96), (128, 80), (200, 332)]:
        x = torch.rand(1, desc.input_channels, h, w)
        with torch.no_grad():
            ref = model(x).clamp(0, 1).numpy()
        got = np.clip(sess.run(None, {"input": x.numpy()})[0], 0, 1)
        worst = max(worst, float(np.abs(ref - got).max()))
    print(f"largest difference against PyTorch over 3 sizes: {worst:.2e}")


if __name__ == "__main__":
    main()
