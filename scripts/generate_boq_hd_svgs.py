from pathlib import Path
from html import escape

W,H=1448,1086

def svg(title, cols, units, rows, body=15, section=18):
    x=[0]
    for name,w in cols: x.append(x[-1]+w)
    inner=W-36; scale=inner/W; xs=[18+v*scale for v in x]
    top=44; hh=78; y2=top+hh; rh=max(20,(H-top-hh-22)/len(rows))
    o=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       '<rect width="100%" height="100%" fill="white"/>',
       f'<text x="{W/2}" y="28" text-anchor="middle" font-family="Times New Roman,serif" font-size="22" font-weight="700">{escape(title)}</text>',
       f'<rect x="18" y="{top}" width="{inner}" height="{H-top-18}" fill="none" stroke="#111" stroke-width="1.6"/>',
       f'<line x1="18" y1="{top+42}" x2="{W-18}" y2="{top+42}" stroke="#333"/>',
       f'<line x1="18" y1="{y2}" x2="{W-18}" y2="{y2}" stroke="#333"/>']
    for xx in xs[1:-1]: o.append(f'<line x1="{xx:.1f}" y1="{top}" x2="{xx:.1f}" y2="{H-18}" stroke="#555" stroke-width=".8"/>')
    for i,(name,_) in enumerate(cols):
        cx=(xs[i]+xs[i+1])/2
        o.append(f'<text x="{cx:.1f}" y="{top+28}" text-anchor="middle" font-family="Times New Roman,serif" font-size="18" font-weight="700">{escape(name)}</text>')
        if units[i]: o.append(f'<text x="{cx:.1f}" y="{top+66}" text-anchor="middle" font-family="Times New Roman,serif" font-size="15" font-weight="700">{escape(units[i])}</text>')
    y=y2
    for typ,data in rows:
        yn=y+rh
        if typ=="S":
            o.append(f'<rect x="18" y="{y:.1f}" width="{inner}" height="{rh:.1f}" fill="#fafafa"/>')
            o.append(f'<text x="{W/2}" y="{y+rh*.72:.1f}" text-anchor="middle" font-family="Times New Roman,serif" font-size="{section}" font-weight="700">{escape(data)}</text>')
        elif typ=="N":
            o.append(f'<text x="{xs[1]+10:.1f}" y="{y+rh*.72:.1f}" font-family="Times New Roman,serif" font-size="{body}" font-weight="700">{escape(data)}</text>')
        else:
            vals=data.split("|"); wt="700" if typ in ("B","T") else "400"
            for i,v in enumerate(vals):
                if not v: continue
                tx=xs[i]+10 if i==1 else (xs[i]+xs[i+1])/2
                an="start" if i==1 else "middle"
                o.append(f'<text x="{tx:.1f}" y="{y+rh*.72:.1f}" text-anchor="{an}" font-family="Times New Roman,serif" font-size="{body}" font-weight="{wt}">{escape(v)}</text>')
        o.append(f'<line x1="18" y1="{yn:.1f}" x2="{W-18}" y2="{yn:.1f}" stroke="#777" stroke-width=".55"/>'); y=yn
    o.append("</svg>"); return "\n".join(o)

C1=[("Sr. No.",90),("Description",530),("No",100),("L",130),("H",130),("Quantity",190),("Total Quantity",278)]
U1=["","","","","","s.ft","s.ft"]
R1=[
("S","Basement Floor External Wall Paint"),
("R","1|E.W. Grid (6-8)(6-2)|1|37|10|370|370"),
("B","|Deductions:|||||"),("R","|Window|1|0.75|7||"),("B","|After Deductions:||||364.75|364.75"),
("R","2|E.W. Grid (6-8)(D-8)|1|14.5|10|145|145"),("R","3|E.W. Grid (6-8)(6-9)|1|9|10|90|90"),
("R","4|E.W. Grid (D-9)(A-3)|1|15.5|10|155|155"),("R","5|E.W. Grid (A-4)(A-2)|1|46|10|460|460"),
("R","6|E.W. Grid (A-2)(6-2)|1|30|10|300|300"),("B","|Deductions:|||||"),
("R","|Ventilation V5|1|3|1.5|4.5|4.5"),("R","|Ventilation V3|1|8|1.5|12|12"),("R","|Ventilation V4|1|3.5|1.5|5.25|5.25"),
("B","|After Deductions:||||278.25|278.25"),("T","|Total Basement Ext. Wall Paint||||1493|1493"),
("S","for Slab of Basement"),
("R","7|Ext. Grid (6-2)(6-8)|1|37|0.5|18.5|18.5"),("R","8|Ext. Grid (A-2)(6-2)|1|30|0.5|15|15"),
("R","9|Ext. Grid (A-2)(A-9)|1|46|0.5|23|23"),("R","10|Ext. Grid (A-9)(D-9)|1|15.5|0.5|7.75|7.75"),
("R","11|Ext. Grid (D-8)(D-9)|1|9|0.5|4.5|4.5"),("R","12|Ext. Grid (D-8)(6-8)|1|15.25|0.5|7.625|7.625"),
("T","|Basement Slab Paint|1|152.75|3|76.375|76.375"),
("S","Basement floor Internal Wall Paint"),
("R","13|I.W. Grid (A-9)(D-9)|1|14|10|140|140"),("R","14|I.W. Grid (D-9)(D-7)|1|13|10|130|130"),
("B","|Deductions: Door D2|1|4|7|28|28"),("B","|After Deductions: Door D2||||102|102"),
("R","15|I.W. Grid (A-9)(A-7)|1|13|10|130|130"),("R","16|I.W. Grid (A-7)(D-7)|1|13|10|130|130"),
("B","|Deductions: Window W1|1|8|6|48|48"),("B","|After Deductions: Window W1||||82|82"),
("R","17|I.W. Grid (D-8)(E-8)|1|4.75|10|47.5|47.5"),("R","18|I.W. Grid (E-8)(6-8)|1|8.75|10|87.5|87.5"),
("R","19|I.W. Grid (6-8)(6-8)|1|8.75|10|87.5|87.5"),("R","20|I.W. Grid (6-8)(E-8)|1|8.75|10|87.5|87.5"),
("R","21|I.W. Grid (D-7)(D-5)|1|6.5|10|65|65"),("B","|Deductions: Window W5|1|5|6|30|30"),
("B","|After Deductions: Window W5||||35|35"),("R","22|I.W. Grid (D-6)(6-6)|1|9.375|10|93.75|93.75"),
("R","23|I.W. Grid (6-6)(6-4)|1|13.375|10|133.75|133.75"),("R","24|I.W. Grid (6-4)(D-4)|1|13.375|10|133.75|133.75")]

C2=[("Sr. No.",90),("Description",530),("No",100),("L",130),("W",130),("Quantity",190),("Total Quantity",278)]
U2=["","","","","","(s.ft)","(s.ft)"]
R2=[
("S","Basement Floor Tiles Area"),
("R","1|Grids (A-7/D-7; D-7/D-9; A-9/D-9; A-7/A-9)|1|13|14|182|182"),
("R","2|Grids (A-5/A-7; A-5/B-5; B-5/B-7; A-7/B-7)|1|5|3.25|16.25|16.25"),
("R","3|Grids (B-5/B-7; D-5/D-7; B-5/D-5; B-7/D-7)|1|5|10|50|50"),
("R","4|Grids (A-4/A-5; D-4/D-5; A-4/D-4; A-5/D-5)|1|12|14|168|168"),
("R","5|Grids (A-2/A-4; A-4/C-4; C-2/C-4; A-2/C-2)|1|12.25|5.375|65.84375|65.84375"),
("R","6|Grids (C-2/E-2; C-2/C-4; C-4/E-4; E-2/E-4)|1|12.25|13|159.25|159.25"),
("R","7|Grids (E-2/G-2; E-2/E-4; G-2/G-4; E-4/G-4)|1|12.25|9|110.25|110.25"),
("R","8|Grids (D-4/G-4; D-8/G-8; D-4/G-8; G-4/G-8)|1|22.5|13.75|309.375|309.375"),
("B","|Deductions:|||||"),("R","|Wall 4.5\"|1|9|0.375|3.375|"),("R","|(Assume) Staircase|1|2|2|4|"),
("B","|After Deductions:||||302|302"),("T","|Total Basement||||1362.96875|1362.96875"),
("S","Ground Floor Tiles Area"),("R","9|Grids (D-9/F-9; E-1/F-11; D-9/D-11; F-9/F-11)|1|16|13.75|220|220"),
("T","|Total Ground||||1582.96875|1582.96875"),("S","First Floor Tiles Area"),
("T","|Total Ground||||1582.96875|1582.96875"),("B","|Deductions:|1|7|14.3|100.1|100.1"),
("T","|Total First Floor||||1482.86875|1482.86875"),("N","Ceiling Paint is equal to the floor tiles."),
("S","Basement Floor Skirting Area"),
("R","1|Grid (A-7/A-9)|1|13|0.3|3.9|3.9"),("R","2|Grid (A-9/D-9)|1|14|0.3|4.2|4.2"),
("R","3|Grid (A-7/D-7)|1|14|0.3|4.2|4.2"),("R","4|Grid (D-7/D-9)|1|13|0.3|3.9|"),
("B","|Deductions:|||||"),("R","|Door D2|1|4|0.3|1.2|"),("B","|After Deductions:||||2.7|2.7"),
("R","5|Grid (A-5/A-7)|1|5|0.3|1.5|1.5"),("R","6|Grid (A-5/B-5)|1|3.25|0.3|0.975|")]

C3=[("Sr. No.",100),("Description",500),("No",110),("L",140),("H",140),("Quantity",190),("Total Quantity",268)]
U3=["","","","","","(r.ft)","(r.ft)"]
R3=[
("S","Basement Floor Window & Ventilations"),
("R","1|Grid(A-2/C-2)Ventilation, V5|1|3|1.5|4.5|4.5"),("R","2|Grid(C-2/E-2)Ventilation, V3|1|8|1.5|12|12"),
("R","3|Grid(F-2/G-2)Ventilation, V4|1|3.5|1.5|5.25|5.25"),("R","4|Grid(B-6/B-7)Ventilation, V6|1|3|1.5|4.5|4.5"),
("R","5|Grid(B-5/D-5)Window, W1|1|8|6|48|48"),("R","6|Grid(B-7/D-7)Window, W1|1|8|6|48|48"),
("R","7|Grid(F-4/G-4)Window, W0|1|4|7|28|28"),("R","8|Grid(D-5/D-7)Window, W5|1|5|6|30|30"),
("S","Ground Floor Window & Ventilations"),
("R","1|Grid(A-3/C-3)Ventilation, V1|1|3|1.5|4.5|4.5"),("R","2|Grid(C-3/E-3)Window, W2|1|8|6|48|48"),
("R","3|Grid(E-3/F-3)Window, W4|1|4.5|3.5|15.75|15.75"),("R","4|Grid(E-5/F-5)Window, W0|1|4|7|28|28"),
("R","5|Grid(B-6/D-6)Window, W1|1|8|6|48|48"),("R","6|Grid(B-7/B-8)Ventilation, V6|1|3|1.5|4.5|4.5"),
("R","7|Grid(B-8/D-8)Window, W1|1|8|6|48|48"),("R","8|Grid(D-6/D-8)Window, W5|1|5|6|30|30"),
("R","9|Grid(E-9/F-9)Window, W3|1|6|6|36|36"),("R","10|Grid(A-10/D-10)Window, W2|1|8|6|48|48"),
("S","First Floor Window & Ventilations"),
("R","1|Grid(A-1/C-1)Ventilation, V1|1|3|1.5|4.5|4.5"),("R","2|Grid(C-1/E-1)Window, W2|1|8|6|48|48"),
("R","3|Grid(E-1/F-1)Window, W4|1|4.5|3.5|15.75|15.75"),("R","4|Grid(B-4/D-4)Window, W1|1|8|6|48|48"),
("R","5|Grid(E-5/B-6)Ventilation, V6|1|3|1.5|4.5|4.5"),("R","6|Grid(B-6/D-6)Window, W1|1|8|6|48|48"),
("R","7|Grid(D-4/D-6)Window, W5|1|5|6|30|30"),("R","8|Grid(E-7/F-7)Window, W3|1|6|6|36|36"),
("R","9|Grid(A-9/D-9)Window, W2|1|8|6|48|48"),("R","10|Grid(D-9/E-9)Ventilation, V2|1|3|1.5|4.5|4.5"),
("T","|Total Window & Ventilations|28||||778.25")]

out=Path("assets/img"); out.mkdir(parents=True,exist_ok=True)
(out/"boq-carousel-hd-1.svg").write_text(svg("Quantity TakeOff for Internal External Paints.",C1,U1,R1,14,17))
(out/"boq-carousel-hd-2.svg").write_text(svg("Quantity TakeOff for Tiles, Ceiling Paint Skirting",C2,U2,R2,15,18))
(out/"boq-carousel-hd-3.svg").write_text(svg("Quantity TakeOff — Windows & Ventilations",C3,U3,R3,15,18))
