import os, zipfile

os.makedirs("samples", exist_ok=True)

# ---------- 生成 EPUB ----------
epub_path = "samples/test.epub"
mimetype = b"application/epub+zip"
container = b'''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>'''
content_opf = b'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-1234</dc:identifier>
    <dc:title>Test English Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>'''
nav_xhtml = b'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Test</title></head>
<body>
  <nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li><li><a href="chapter2.xhtml">Chapter 2</a></li></ol></nav>
</body></html>'''
chapter1 = b'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
<h1>Chapter 1</h1>
<p>The quick brown fox jumps over the lazy dog. She was contemplating the mysterious circumstances of the ancient manuscript.</p>
<p>He whispered a gentle remark about the ephemeral nature of happiness. The dictionary defines "serendipity" as a pleasant surprise.</p>
</body></html>'''
chapter2 = b'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
<h1>Chapter 2</h1>
<p>Nevertheless, the wandering traveler discovered an extraordinary tranquil village beyond the misty mountains.</p>
<p>Curiosity propelled him forward into the luminous cathedral of forgotten dreams and whispered promises.</p>
</body></html>'''

with zipfile.ZipFile(epub_path, "w") as z:
    z.writestr("mimetype", mimetype, compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", container)
    z.writestr("OEBPS/content.opf", content_opf)
    z.writestr("OEBPS/nav.xhtml", nav_xhtml)
    z.writestr("OEBPS/chapter1.xhtml", chapter1)
    z.writestr("OEBPS/chapter2.xhtml", chapter2)
print("EPUB written:", epub_path, os.path.getsize(epub_path), "bytes")

# ---------- 生成 PDF（手写最小合法 PDF） ----------
pdf_path = "samples/test.pdf"
objects = []
objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objects.append(b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>")
objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>")
page1 = b"BT /F1 16 Tf 40 250 Td (The quick brown fox jumps.) Tj 0 -24 Td (She was contemplating the mysterious manuscript.) Tj ET"
objects.append(b"<< /Length " + str(len(page1)).encode() + b" >>\nstream\n" + page1 + b"\nendstream")
objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>")
page2 = b"BT /F1 16 Tf 40 250 Td (Nevertheless, the wandering traveler discovered.) Tj 0 -24 Td (Curiosity propelled him into the luminous cathedral.) Tj ET"
objects.append(b"<< /Length " + str(len(page2)).encode() + b" >>\nstream\n" + page2 + b"\nendstream")
objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

pdf = b"%PDF-1.4\n"
offsets = []
for i, obj in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
xref_pos = len(pdf)
pdf += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
pdf += b"0000000000 65535 f \n"
for off in offsets:
    pdf += ("%010d 00000 n \n" % off).encode()
pdf += b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref_pos).encode() + b"\n%%EOF"
with open(pdf_path, "wb") as f:
    f.write(pdf)
print("PDF written:", pdf_path, os.path.getsize(pdf_path), "bytes")
