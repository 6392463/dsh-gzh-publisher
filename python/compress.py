#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一张图压进给定字节数以内（微信公众号正文配图上限 1MB）。

用法：
    python compress.py --in a.png --out a.jpg --max-bytes 1048576 --max-edge 1440

约定：stdout **只有一行 JSON**，全部 ASCII（诊断信息走 stderr），这样 Node 侧只认那一行。
退出码：0 = 压好了（或本来就在限制内）；1 = 没压成（JSON 里带 error，Node 侧原样转给人看）。
"""
import argparse
import io
import json
import os
import sys


META = None


def emit(payload):
    """结果写 stdout，也写 --meta 文件。调用方优先读文件，所以整条链路不依赖管道。"""
    line = json.dumps(payload)
    try:
        sys.stdout.write(line + "\n")
    except Exception:
        pass
    if META:
        try:
            with open(META, "w", encoding="utf-8") as writer:
                writer.write(line)
        except Exception:
            pass


def fail(message, **extra):
    payload = {"ok": False, "error": str(message)}
    payload.update(extra)
    emit(payload)
    return 1


def to_rgb(im):
    """JPEG 没有透明通道：带 alpha 的图先铺白底，避免黑底或报错。"""
    has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        from PIL import Image

        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(bg, rgba).convert("RGB")
    if im.mode != "RGB":
        return im.convert("RGB")
    return im


def main():
    global META
    parser = argparse.ArgumentParser(description="compress one image under a byte budget")
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--out", dest="dst", required=True)
    parser.add_argument("--max-bytes", type=int, default=1048576)
    parser.add_argument("--max-edge", type=int, default=1440)
    parser.add_argument("--quality", type=int, default=0, help="固定质量；0 = 自动阶梯")
    parser.add_argument("--allow-upscale", action="store_true", help="小图不放大，除非明确要")
    parser.add_argument("--meta", dest="meta", default="", help="把这一次的 JSON 结果额外写到这里（调用方读文件，不依赖管道）")
    args = parser.parse_args()
    META = args.meta or None

    try:
        from PIL import Image, ImageOps
    except Exception as exc:  # Pillow 不在，让调用方去装/换解释器
        return fail("Pillow 不可用：" + repr(exc))

    if not os.path.isfile(args.src):
        return fail("源文件不存在：" + args.src)
    budget = max(8192, int(args.max_bytes))
    max_edge = max(64, int(args.max_edge))

    try:
        im = Image.open(args.src)
        im.load()
    except Exception as exc:
        return fail("打不开图片：" + repr(exc))

    try:
        src_bytes = os.path.getsize(args.src)
        # format 要在 exif_transpose 之前取：转置返回的是新对象，format 会变成 None
        original_format = (im.format or "UNKNOWN").upper()
        im = ImageOps.exif_transpose(im)
        width, height = im.size

        # 本来就在限制内，且长边也没超：原样拷一份，调用方拿到统一的输出路径
        if src_bytes <= budget and max(width, height) <= max_edge and not args.allow_upscale:
            with open(args.src, "rb") as reader, open(args.dst, "wb") as writer:
                writer.write(reader.read())
            return ok(src_bytes, width, height, 0, 1.0, original_format, "原图已在限制内，未重编码")

        edge_scale = min(1.0, float(max_edge) / max(width, height)) if max(width, height) > 0 else 1.0
        edge_ladder = [1.0, 0.82, 0.68, 0.55, 0.45, 0.36]
        quality_ladder = [args.quality] if args.quality > 0 else [86, 80, 74, 68, 60, 52, 45, 38]

        last_bytes = 0
        last_w = width
        last_h = height
        last_q = 0
        last_scale = edge_scale
        for factor in edge_ladder:
            scale = edge_scale * factor
            target = (max(64, int(round(width * scale))), max(64, int(round(height * scale))))
            resized = to_rgb(im.resize(target, Image.LANCZOS)) if target != (width, height) else to_rgb(im)
            for quality in quality_ladder:
                buffer = io.BytesIO()
                resized.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
                payload = buffer.getvalue()
                last_bytes, last_w, last_h, last_q, last_scale = len(payload), target[0], target[1], quality, scale
                if len(payload) <= budget:
                    with open(args.dst, "wb") as writer:
                        writer.write(payload)
                    return ok(last_bytes, last_w, last_h, last_q, last_scale, original_format, "")
        # 阶梯走完还超：把最后一次结果写出去，同时明确说没达标（调用方会拒绝上传）
        return fail(
            "压到最狠仍有 {0} 字节，超过预算 {1} 字节".format(last_bytes, budget),
            bytes=last_bytes,
            width=last_w,
            height=last_h,
            quality=last_q,
            srcBytes=src_bytes,
        )
    finally:
        try:
            im.close()
        except Exception:
            pass


def ok(size, width, height, quality, scale, original_format, note):
    payload = {
        "ok": True,
        "bytes": int(size),
        "width": int(width),
        "height": int(height),
        "quality": int(quality),
        "scale": round(float(scale), 3),
        "srcFormat": original_format,
        "note": note,
    }
    emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
