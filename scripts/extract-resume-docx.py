from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_CHARS = 100_000
MAX_DOCUMENT_XML_BYTES = 12 * 1024 * 1024


def clean(value: str) -> str:
    value = value.replace("\x00", "")
    value = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()[:MAX_CHARS]


def extract_docx(filename: Path) -> str:
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(filename) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > MAX_DOCUMENT_XML_BYTES:
            raise RuntimeError("DOCX 正文过大，无法安全提取")
        xml = archive.read(info)
    root = ElementTree.fromstring(xml)
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
        if text.strip():
            paragraphs.append(text.strip())
    return clean("\n".join(paragraphs))


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("missing input path")
    filename = Path(sys.argv[1])
    if filename.suffix.lower() != ".docx":
        raise RuntimeError("仅支持 DOCX")
    text = extract_docx(filename)
    if not text:
        raise RuntimeError("未能从 DOCX 中提取文字")
    print(json.dumps({"text": text}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
