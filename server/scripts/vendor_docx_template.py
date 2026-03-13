import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from copy import deepcopy

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
ET.register_namespace("w", W_NS)

ITEM_RE = re.compile(r"^(?P<code>[A-Za-z0-9.]+)(?P<sep1>[_\s]+)(?:(?P<qty>\d+)(?P<sep2>[_\s]+))?(?P<name>.+)$")


def qn(tag):
    return "{%s}%s" % (W_NS, tag)


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))


def extract_paragraphs(root):
    body = root.find("w:body", NS)
    if body is None:
        return []
    return [child for child in list(body) if child.tag == qn("p")]


def parse_template(input_path):
    with zipfile.ZipFile(input_path, "r") as zf:
        doc_root = ET.fromstring(zf.read("word/document.xml"))

    paragraphs = extract_paragraphs(doc_root)
    item_rows = []
    outline = []
    store_paragraph_index = None
    date_paragraph_index = None

    for idx, paragraph in enumerate(paragraphs):
        text = paragraph_text(paragraph).strip()
        if not text:
            continue
        low = text.lower()
        if low.startswith("store location:"):
            store_paragraph_index = idx
            continue
        if low.startswith("date:"):
            date_paragraph_index = idx
            continue

        match = ITEM_RE.match(text)
        if not match:
            outline.append({"type": "heading", "text": text, "paragraphIndex": idx})
            continue

        code = (match.group("code") or "").strip()
        name = (match.group("name") or "").strip()
        sep1 = match.group("sep1") or ""
        sep2 = match.group("sep2") or ""
        qty = match.group("qty") or ""
        if not code or not name:
            continue
        has_placeholder = ("_" in sep1) or ("_" in sep2)
        # For this vendor form, true item rows either include qty markers or underscore fillers.
        # Plain text lines like "Mirch Masala Froz Meals" are section headings, not items.
        if not qty and not has_placeholder:
            outline.append({"type": "heading", "text": text, "paragraphIndex": idx})
            continue

        item_rows.append(
            {
                "code": code,
                "name": name,
                "paragraphIndex": idx,
                "sep1": sep1,
                "qty": qty,
                "sep2": sep2,
            }
        )
        outline.append({"type": "item", "code": code, "name": name, "paragraphIndex": idx})

    return {
        "kind": "docx_vendor_form",
        "docxMap": {
            "storeParagraphIndex": store_paragraph_index,
            "dateParagraphIndex": date_paragraph_index,
            "itemRows": item_rows,
            "outline": outline,
        },
        "items": [{"code": row["code"], "name": row["name"], "category": "vendor_orders", "unit": ""} for row in item_rows],
    }


def clear_run_text(run):
    for t_node in run.findall("w:t", NS):
        t_node.text = ""


def set_paragraph_text(paragraph, text):
    runs = paragraph.findall("w:r", NS)
    if not runs:
        run = ET.SubElement(paragraph, qn("r"))
        text_node = ET.SubElement(run, qn("t"))
        text_node.text = text
        return

    target_run = runs[0]
    text_nodes = target_run.findall("w:t", NS)
    if text_nodes:
        text_nodes[0].text = text
        for extra in text_nodes[1:]:
            extra.text = ""
    else:
        text_node = ET.SubElement(target_run, qn("t"))
        text_node.text = text

    for run in runs[1:]:
        clear_run_text(run)


def format_item_line(row, quantity):
    qty_text = "" if quantity is None else str(quantity).strip()
    code = row.get("code", "")
    name = row.get("name", "")
    sep1 = row.get("sep1", "")
    sep2 = row.get("sep2", "")
    orig_qty = row.get("qty", "")

    if qty_text == "":
        if orig_qty:
            return f"{code}{sep1}{orig_qty}{sep2}{name}".replace(orig_qty, "".ljust(len(orig_qty), "_"))
        return f"{code}{sep1}{name}"

    if orig_qty:
        return f"{code}{sep1}{qty_text}{sep2}{name}"

    filler = sep1 or "___"
    left_len = max(0, (len(filler) - len(qty_text)) // 2)
    right_len = max(0, len(filler) - len(qty_text) - left_len)
    left = filler[:left_len] if left_len else ""
    right = filler[-right_len:] if right_len else ""
    if not left:
        left = "_" * max(1, (len(filler) // 2))
    if not right:
        right = "_" * max(1, len(filler) - len(left))
    return f"{code}{left}{qty_text}{right}{name}"


def render_template(input_path, payload_path, output_path):
    with open(payload_path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    with zipfile.ZipFile(input_path, "r") as zf:
        file_map = {name: zf.read(name) for name in zf.namelist()}

    doc_root = ET.fromstring(file_map["word/document.xml"])
    paragraphs = extract_paragraphs(doc_root)
    docx_map = payload.get("docxMap") or {}
    store_name = str(payload.get("storeName") or "").strip()
    date_text = str(payload.get("dateText") or "").strip()
    quantities = payload.get("quantitiesByCode") or {}

    store_idx = docx_map.get("storeParagraphIndex")
    if isinstance(store_idx, int) and 0 <= store_idx < len(paragraphs):
        set_paragraph_text(paragraphs[store_idx], f"Store Location: {store_name}")

    date_idx = docx_map.get("dateParagraphIndex")
    if isinstance(date_idx, int) and 0 <= date_idx < len(paragraphs):
        set_paragraph_text(paragraphs[date_idx], f"Date: {date_text}")

    for row in docx_map.get("itemRows") or []:
        p_idx = row.get("paragraphIndex")
        if not isinstance(p_idx, int) or not (0 <= p_idx < len(paragraphs)):
            continue
        code = str(row.get("code") or "").strip()
        qty_value = quantities.get(code)
        qty_number = int(qty_value) if qty_value is not None and str(qty_value).strip() else 0
        line_text = format_item_line(row, qty_number if qty_number > 0 else "")
        set_paragraph_text(paragraphs[p_idx], line_text)

    file_map["word/document.xml"] = ET.tostring(doc_root, encoding="utf-8", xml_declaration=True)

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out_zip:
        for name, content in file_map.items():
            out_zip.writestr(name, content)


def main():
    if len(sys.argv) < 3:
        print("usage: vendor_docx_template.py parse <input> | render <input> <payload.json> <output>", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "parse":
        result = parse_template(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False))
        return

    if cmd == "render":
        if len(sys.argv) < 5:
            print("render requires input, payload json, output", file=sys.stderr)
            sys.exit(1)
        render_template(sys.argv[2], sys.argv[3], sys.argv[4])
        print(json.dumps({"success": True}))
        return

    print("unknown command", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
