from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_CHARS = 100_000


def clean(value: str) -> str:
    value = value.replace("\x00", "")
    value = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()[:MAX_CHARS]


def extract_docx(filename: Path) -> str:
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(filename) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
        if text.strip():
            paragraphs.append(text.strip())
    return clean("\n".join(paragraphs))


def extract_pdf(filename: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise RuntimeError("缺少 pypdf 依赖；请重新启动 job-tracer 以安装简历解析组件") from error
    reader = PdfReader(str(filename))
    pages: list[str] = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
        if sum(len(item) for item in pages) >= MAX_CHARS:
            break
    return clean("\n".join(pages))


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("missing input path")
    filename = Path(sys.argv[1])
    extension = filename.suffix.lower()
    if extension == ".pdf":
        text = extract_pdf(filename)
    elif extension == ".docx":
        text = extract_docx(filename)
    elif extension == ".doc":
        raise RuntimeError("旧版 .doc 暂不支持自动提取，请在 Word 中另存为 .docx 或导出为 PDF 后重新上传")
    else:
        raise RuntimeError("不支持的简历格式")
    if not text:
        raise RuntimeError("未能从文件中提取文本；若为扫描件，请使用可复制文字的 PDF 或 DOCX")
    print(json.dumps({"text": text}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
