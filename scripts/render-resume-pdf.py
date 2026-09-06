from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


MAX_PAGES = 8
MAX_LONG_EDGE = 1800
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024


def render_page(page, page_number: int, output_dir: Path) -> dict[str, object]:
    import fitz

    longest = max(float(page.rect.width), float(page.rect.height), 1.0)
    scale = min(2.0, MAX_LONG_EDGE / longest)
    for _ in range(4):
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        data = pixmap.tobytes("jpeg", jpg_quality=82)
        if len(data) <= MAX_PAGE_BYTES or scale <= 0.5:
            break
        scale *= 0.72
    if len(data) > MAX_PAGE_BYTES:
        raise RuntimeError(f"第 {page_number} 页渲染后仍超过图片大小限制")
    target = output_dir / f"page-{page_number}.jpg"
    target.write_bytes(data)
    return {"path": str(target), "width": pixmap.width, "height": pixmap.height, "bytes": len(data)}


def main() -> int:
    if len(sys.argv) != 3:
        raise RuntimeError("usage: render-resume-pdf.py <pdf> <output-dir>")
    source = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    if not output_dir.exists():
        output_dir.mkdir(parents=True)
    elif any(output_dir.iterdir()):
        raise RuntimeError("PDF 渲染临时目录不是空目录")
    try:
        import fitz

        document = fitz.open(source)
        if not document.page_count:
            raise RuntimeError("PDF 没有可识别页面")
        if document.page_count > MAX_PAGES:
            raise RuntimeError(f"简历 PDF 最多支持 {MAX_PAGES} 页，当前为 {document.page_count} 页")
        pages: list[dict[str, object]] = []
        total_bytes = 0
        for number, page in enumerate(document, start=1):
            rendered = render_page(page, number, output_dir)
            total_bytes += int(rendered["bytes"])
            if total_bytes > MAX_TOTAL_BYTES:
                raise RuntimeError("PDF 渲染图片总大小超过限制，请使用更小的简历文件")
            pages.append(rendered)
        document.close()
        print(json.dumps({"pages": pages, "total_bytes": total_bytes}, ensure_ascii=False))
        return 0
    except Exception:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
