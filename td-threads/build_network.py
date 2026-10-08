"""
在 TouchDesigner 裡一鍵長出整個網絡。

用法:把這個檔案拖進 TD 的網絡編輯器(會變成名為 build_network 的 Text DAT),
打開 Textport(Alt+T),輸入:

    mod('build_network').build()

會在 /project1 底下建立:
  input/   OSC 接收(數值 port 7000、串文 port 7001)與最近 50 則串文表
  logic/   讀取通道的小工具(chan)
  output/  三條熱度條 + 關鍵字標籤 + 最新一則串文,合成到 out
重跑會先刪掉這三個 COMP 再重建。
"""

KEYWORDS = [            # (slug, 顯示文字, 顏色 RGB 0~1) — slug 要跟 bridge 的 config.json 一致
    ("flame",   "炎上", (1.00, 0.30, 0.10)),
    ("trial",   "公審", (0.95, 0.95, 0.95)),
    ("boycott", "抵制", (0.10, 0.80, 1.00)),
]
PORT_VALUES = 7000
PORT_POSTS = 7001
W, H = 1920, 1080


def setp(o, **pars):
    """設定參數;TD 版本間參數名不同時只警告、不中斷。值是 ('expr', '...') 就設成運算式。"""
    for name, val in pars.items():
        p = getattr(o.par, name, None)
        if p is None:
            print(f'[build] {o.path} 沒有參數 {name},略過')
            continue
        if isinstance(val, tuple) and val and val[0] == 'expr':
            p.expr = val[1]
            p.mode = ParMode.EXPRESSION
        else:
            p.val = val


def place(o, x, y):
    o.nodeX, o.nodeY = x, y
    return o


def build():
    root = op('/project1')
    for name in ('input', 'logic', 'output'):
        old = root.op(name)
        if old:
            old.destroy()

    # ── input:OSC 進來 ─────────────────────────────
    inp = place(root.create(baseCOMP, 'input'), -400, 0)
    vals = place(inp.create(oscinCHOP, 'osc_values'), 0, 0)
    setp(vals, port=PORT_VALUES)

    table = place(inp.create(tableDAT, 'posts'), 200, -200)
    table.clear()
    table.appendRow(['slug', 'keyword', 'author', 'text', 'time'])

    cb = place(inp.create(textDAT, 'posts_callbacks'), 0, -400)
    cb.text = POSTS_CALLBACKS
    posts = place(inp.create(oscinDAT, 'osc_posts'), 0, -200)
    setp(posts, port=PORT_POSTS, callbacks=cb.path)

    # ── logic:讀通道的工具 ─────────────────────────
    logic = place(root.create(baseCOMP, 'logic'), 0, 0)
    chan = place(logic.create(textDAT, 'chan'), 0, 0)
    chan.text = CHAN_MODULE
    G = "op('/project1/logic/chan').module.get"

    # ── output:視覺 ───────────────────────────────
    out = place(root.create(baseCOMP, 'output'), 400, 0)
    bg = place(out.create(constantTOP, 'bg'), 0, 300)
    setp(bg, outputresolution='custom', resolutionw=W, resolutionh=H, colorr=0.02, colorg=0.02, colorb=0.03)

    comp = place(out.create(compositeTOP, 'comp'), 800, 0)
    setp(comp, operand='over', outputresolution='custom', resolutionw=W, resolutionh=H)
    layers = [bg]

    for i, (slug, label, (r, g, b)) in enumerate(KEYWORDS):
        y = 0.72 - i * 0.16                      # 由上往下排
        bar = place(out.create(rectangleTOP, f'bar_{slug}'), 0, -i * 300)
        setp(bar, outputresolution='custom', resolutionw=W, resolutionh=H,
             sizeunit='fraction', centerunit='fraction',
             sizex=('expr', f"max(0.002, 0.9 * {G}('{slug}/heat'))"), sizey=0.035,
             centerx=('expr', f"-0.46 + 0.45 * {G}('{slug}/heat')"), centery=y - 0.5 - 0.055,
             fillcolorr=r, fillcolorg=g, fillcolorb=b, fillalpha=1,
             bgalpha=0)
        txt = place(out.create(textTOP, f'label_{slug}'), 200, -i * 300)
        setp(txt, outputresolution='custom', resolutionw=W, resolutionh=H,
             text=('expr', f"'{label}  ' + str(int({G}('{slug}/total'))) + ' 則 / 一小時 ' + str(int({G}('{slug}/hour')))"),
             fontsizex=40, alignx='left', aligny='center',
             positionunit='fraction', positionx=0.04 - 0.5, positiony=y - 0.5,
             fontcolorr=r, fontcolorg=g, fontcolorb=b, bgalpha=0)
        layers += [bar, txt]

    latest = place(out.create(textTOP, 'latest_post'), 200, -1000)
    setp(latest, outputresolution='custom', resolutionw=W, resolutionh=H,
         text=('expr', "op('/project1/input/posts')[op('/project1/input/posts').numRows-1, 'text'] "
                       "if op('/project1/input/posts').numRows > 1 else '等待串文…'"),
         fontsizex=34, alignx='center', aligny='center', wordwrap=True,
         positionunit='fraction', positiony=-0.28,
         fontcolorr=0.9, fontcolorg=0.9, fontcolorb=0.9, bgalpha=0)
    status = place(out.create(textTOP, 'status'), 200, -1300)
    setp(status, outputresolution='custom', resolutionw=W, resolutionh=H,
         text=('expr', f"('● 連線中' if {G}('status/ok') > 0.5 else '○ 查詢失敗') + "
                       f"'   下次查詢 ' + str(int({G}('status/next'))) + ' 秒'"),
         fontsizex=22, alignx='right', aligny='bottom', positionunit='fraction',
         positionx=0.47, positiony=-0.46, fontcolorr=0.5, fontcolorg=0.5, fontcolorb=0.5, bgalpha=0)
    layers += [latest, status]

    for layer in layers:                         # 依序接到 comp 的下一個空輸入
        layer.outputConnectors[0].connect(comp)
    final = place(out.create(nullTOP, 'out'), 1000, 0)
    comp.outputConnectors[0].connect(final)

    print('[build] 完成:資料進 /project1/input,畫面在 /project1/output/out')


# OSC In DAT 的 callbacks:把 /post 寫進 posts 表,保留最近 50 則
POSTS_CALLBACKS = '''
MAX_ROWS = 50

def onReceiveOSC(dat, rowIndex, message, bytes, timeStamp, address, args, peer):
    if address != '/post' or len(args) < 5:
        return
    t = op('posts')
    t.appendRow([args[0], args[1], args[2], args[3], args[4]])
    while t.numRows > MAX_ROWS + 1:
        t.deleteRow(1)
    return
'''

# OSC In CHOP 的通道名在不同版本可能是 kw/flame/heat 或 kw_flame_heat,這裡兩種都認
CHAN_MODULE = '''
def get(name, default=0.0):
    src = op('/project1/input/osc_values')
    want = name.replace('_', '/').strip('/')
    for c in src.chans():
        if c.name.replace('_', '/').strip('/').endswith(want):
            return c.eval()
    return default
'''
