# 看板娘素材生产（Console Mascot Pipeline）

> 现在的看板娘是**一段 10 秒 / 24fps 的循环动画**，趴在输入框上沿：
> `console/client/mascot/mascot-loop.webm`（VP9 + alpha，800×771，1.3 MB）
> 加一张静态封面 `mascot-poster.webp`（视频解不出来时兜底）。
>
> 换角色/换动作都走同一条流水线：**白底循环视频 → 拆帧 → 抠白底 → 编 VP9 alpha → 改 CSS 宽高比**。

---

## 1. 生成视频（提示词）

模型：`aistudio/gemini-nano-banana-2.1`（9router），**一定要把角色设定稿当参考图传进去**，
否则脸和发色会飘：

- `Character_design_sheet_creation_2K_20261020164352.jpg`（三视图设定稿）
- `Generated Image October 20, 2026 - 4_44PM.jpg`（大头近景，脸最准）

提示词（生成视频时把画面要求写在前面，把「动作序列」逐条列出来）：

```
Use the attached character design sheet as the exact reference for this character.
Keep her face shape, eye style, hair color and the rainbow butterfly hair clip identical.

A cute chibi anime girl lying on her stomach, upper body only, leaning forward toward
the viewer, both forearms resting on an invisible surface in front of her, looking
straight at the camera. Long straight crimson-red hair with one single curved ahoge,
big lavender-purple eyes with star-shaped highlights, pastel rainbow butterfly hair clip
on the right side of her hair, white sailor-collar blouse with pale pink stripes, red
ribbon bow at the chest, puffy long sleeves.

A seamless 10 second looping animation, 24 fps, fixed camera, she never leaves the frame:
  0.0-1.4s  both hands under her chin, gentle smile, small idle head bob
  1.6-3.0s  she raises one hand and waves hello twice, smiling
  3.2-4.0s  hands back under her chin, talking happily
  4.2-5.6s  she winks and sticks her tongue out playfully
  5.8-6.8s  she puffs her cheeks and raises both fists, pouting
  7.0-8.2s  annoyed: an anger mark pops on her head, a small smoke puff from her nose
  8.4-9.8s  she bangs both fists on the surface with little impact sparkles
  9.8-10.0s settles back into the first pose so the loop is seamless

Clean modern anime illustration, soft cel shading, crisp clean outlines, gentle pastel
lighting. Flat pure white background, no table, no desk, no props, no text, no watermark,
no camera movement, no scene cuts.
```

**硬要求**：纯白或纯绿（`#00FF00`）背景、固定机位、角色不出画、首尾姿势接得上（无缝循环）、10 秒、24fps。
**实测用绿幕最好抠**（这一版就是绿幕）：：要求「flat pure green screen background #00FF00, no shadow, no gradient, no vignette」，
这样就不存在白色校服和背景同色、以及桌面投影的问题。绿幕时把她往画面中央放、四周留一圈干净幕布。

---

## 2. 拆帧 + 抠背景

```bash
# 1) 拆全部帧（24fps x 10s = 240 帧）
ffmpeg -i mascot.mp4 -fps_mode passthrough frames/src/%04d.png

# 2) 逐帧抠背景 -> 透明 RGBA（--key auto 会自己判断是白底还是绿幕）
python scripts/mascot_video_frames.py \
  --frames frames/src --out frames/rgba \
  --key auto --crop 400,0,1520,1080 --keep-floor --t0 10 --t1 50
```

`scripts/mascot_video_frames.py` 干的三件事：

1. **固定裁切**：所有帧同一刀，对齐靠裁切本身，不能逐帧算包围盒（否则整段会抖）。
   底边就是「压在输入框上沿」的那条线。当前用的是 `--crop 480,0,1480,966`（源 1920×1080）。**裁切底线就取她身下那条深红色横线**（y≈958~965，宽约 711px）——这条红线是画面里最稳的对齐基准，抠完它正好是素材的最后一行，页面上让这一行压在输入框上边框上即可，
   不给 `--crop` 时会扫 12 帧取并集包围盒自动算，**算完会打印该同步到 CSS 的宽高比**。
2. **抠背景**：
   - 白底：四边 flood fill（`mn > 195 & sat < 26`），边缘 2px 按 `α = 1 - min(R,G,B)/255` 反预乘去白边
   - **绿幕 / 品红幕**：按四角颜色算 RGB 距离 `α = clamp((d-28)/(90-28))`，再做 despill 去溢色
3. **清投影**（仅白底）：她手肘下面那层浅灰投影被手臂围成口袋，边框 flood fill 进不去，
   所以再单独找「与背景连通、亮度 175~246」的浅灰一起吃掉；白色校服（≥248）会挡住它，不会被误伤。
   **绿幕版没有这个问题——幕布上不会画投影，一步到位。**

---

## 3. 编 VP9 + alpha

```bash
ffmpeg -framerate 30 -i frames/rgba/%04d.png \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 \
  -crf 42 -b:v 0 -an -row-mt 1 -cpu-used 2 -lag-in-frames 0 \
  mascot-loop.webm
```

- **`-auto-alt-ref 0` 是必须的**：libvpx 的 alpha 编码和 alt-ref 帧不兼容，
  不加会被静默降级成 `yuv420p`（透明直接没了，页面上一圈白底）。
  报错文案是 `Transparency encoding with auto_alt_ref does not work`。
- **帧率就是播放速度**：`-framerate 30` 让 240 帧在 8 秒播完（每秒 30 帧）。24 → 10 秒、48 → 5 秒，按口味调。
  改帧率后 `REACTIONS` 里的跳转时间点必须按 `24 / 新帧率` 换算（30fps 就是全部 ×0.8），否则点击会跳到错的表情段落。
- `ffprobe` 看这个文件仍然显示 `yuv420p`，**这不代表没有 alpha** —— alpha 存在 BlockAdditional 里，
  用 Chrome/Edge/Firefox 打开是对的（拿 ffmpeg 解帧看不到 alpha，别被误导）。
- 静态封面：`python -c "from PIL import Image; Image.open('frames/rgba/0001.png').save('mascot-poster.webp','WEBP',quality=90,method=6)"`

---

## 4. 接进控制台（必须内联）

1. 素材丢到 `console/client/mascot/`：`mascot-loop.webm` + `mascot-poster.webp`
   **然后必须内联进 index.html**：`python scripts/inline_mascot.py`
   （控制台是单文件前端，`server.mjs` 只把 index.html 的字节吐给 `/`，没有静态资源路由；
   线上也是 `scp index.html` 单文件部署。相对路径 `src="mascot/..."` 在服务器上必然 404，
   表现就是「看板娘不显示」。脚本幂等，已经是 data URI 会跳过；`--check` 只检查不写）
2. 改 `.mascot-dock` 的宽高比：`--mascot-h: calc(var(--mascot-w) * 0.9637)`（= 771/800）
3. 重建 demo（会把 webm 一起内联成 data URI）+ 语法校验：

```bash
python scripts/build_demo.py
node --test --test-force-exit tests/console_client_syntax.mjs
```

4. 点她跳的「表情段落」时间点在 `index.html` 里看板娘脚本的 `REACTIONS`（秒）：
   `1.8 挥手 / 3.6 说话 / 5.0 眨眼吐舌 / 6.4 鼓脸 / 7.6 生气 / 8.8 惊讶`，
   换视频后按新段落改这几个数。

---

## 5. 自检

- [ ] 首尾两帧接得上（循环不跳）
- [ ] 背景全透明：亮色、暗色主题各看一眼，不能有白底、白边、灰投影
- [ ] 底边平齐：她身体最下面一行正好压在输入框上沿
- [ ] 文件 ≤ 1.5 MB（超过就调 `-crf` 到 45，或把 `--width` 降到 700）
- [ ] 切到设置页时视频暂停（`IntersectionObserver` 负责），回来继续播
