// 开屏动画：每次唤起工具条（首次注入 / 切回显示）时全屏播一遍品牌动画。
// 由 background 在 toggle-in 的两条路径上 executeScript 注入，与 inject.js /
// restore.js 并行执行，互不依赖。
;(() => {
  const platform = typeof browser === 'undefined' ? chrome : browser

  const OVERLAY_ID = 'liaison-splash-overlay'
  const HIDE_STYLE_ID = 'liaison-splash-hide'
  if (document.getElementById(OVERLAY_ID)) return   // 防重复注入

  // 动画期间先藏起工具条和猫按钮，播完再放出来（避免动画没完 UI 先冒出来）。
  // 用 !important 样式表压制，因为按钮有 rAF 循环在不断写内联 display。
  const hideStyle = document.createElement('style')
  hideStyle.id = HIDE_STYLE_ID
  // 工具条(liaison-top-toolbar)是挂在 body 下的独立顶层元素，不在 liaison-app 里，要单独列
  hideStyle.textContent = 'liaison-app, liaison-top-toolbar, #__li-toolbar-close-btn, #__li-hover-freeze-btn { opacity: 0 !important; pointer-events: none !important; }'
  ;(document.head || document.documentElement).appendChild(hideStyle)

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  // 全部内联样式 + 显式钉死可继承属性，避免宿主页样式渗入
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:#000',   // 开场是黑底液态金属，起手不能闪白
    'display:flex', 'align-items:center', 'justify-content:center',
    'opacity:0', 'transition:opacity .7s ease',
    'cursor:pointer', 'line-height:normal', 'margin:0', 'padding:0',
  ].join(';')

  const video = document.createElement('video')
  video.muted = true
  video.autoplay = false   // 快闪末帧亮相时起播；快闪不可用时回退为立即播
  video.playsInline = true
  video.src = platform.runtime.getURL('toolbar/assets/splash.webm')
  video.style.cssText = [
    // 位置和尺寸由 placeVideo() 按快闪猫的屏上几何实时反算，
    // 让视频里的猫和快闪末帧的猫逐像素重合，衔接零跳变
    'position:absolute', 'display:block', 'pointer-events:none',
    'margin:0', 'padding:0', 'border:0', 'background:transparent',
    'opacity:0', 'transition:opacity 1s ease',
  ].join(';')

  // ===== 液态金属段：黑底上的猫头 logo，流动金属质感 =====
  // 取代原十图快闪。纹理是离线预生成的距离场图（R=边缘梯度 / G=不透明度），
  // 运行时零 Poisson 计算；参数沿用 paper-shaders 默认预设 + 黑色背景。
  const LM_MS = 2100            // 液态金属停留时长（含 .7s 入场渐显）
  const LM_FADE_MS = 700        // 溶解进睁眼视频的交叠时长
  // 睁眼视频(480x480)：眼中点 (49.65%, 67.14%)，眼距为边长的 16.8%
  const VID_EYE_RX = 0.4965, VID_EYE_RY = 0.6714, VID_EYE_D = 0.168
  // 液态金属画布里猫头的几何（scale .3 + fit contain 渲染后实测，非源 SVG 推算）：
  // 眼中点 (49.86%, 49.14%)、眼距为画布边长的 5.11%。改 u_scale 须重测这三个值。
  const LM_EYE_RX = 0.4986, LM_EYE_RY = 0.4914, LM_EYE_D = 0.0511
  // 黑金猫头单独上移 4px 做视觉对位微调。故意不进 placeVideo：
  // 睁眼视频保持原位，只挪液金这一层。
  const LM_SHIFT_Y = -4

  const lmWrap = document.createElement('div')
  lmWrap.style.cssText = [
    'position:absolute', 'inset:0', 'overflow:hidden', 'z-index:2',
    'pointer-events:none', 'margin:0', 'padding:0', 'border:0', 'background:#000',
    'opacity:1', 'display:flex', 'align-items:center', 'justify-content:center',
  ].join(';')
  // shader 画布是正方形，边长取视口短边的 62%，与睁眼视频的猫等大
  const lmHost = document.createElement('div')
  const lmSize = () => Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.62)
  lmHost.style.cssText = [
    'position:relative', 'margin:0', 'padding:0', 'border:0',
    // flex-shrink:0 —— 否则会被 flex 拉成矩形，contain 基准变化导致锚点失准
    'flex:0 0 auto', 'box-sizing:border-box',
    'width:' + lmSize() + 'px', 'height:' + lmSize() + 'px',
    'transform:translateY(' + LM_SHIFT_Y + 'px)',
  ].join(';')
  lmWrap.appendChild(lmHost)

  const placeVideo = () => {
    // 让睁眼视频里的猫眼与液态金属画布里的猫眼逐像素重合，衔接零跳变
    const vw = window.innerWidth, vh = window.innerHeight
    const L = lmSize()
    // lmHost 是 flex 居中的正方形，据此换算液金猫眼的屏上坐标
    const eyeX = (vw - L) / 2 + LM_EYE_RX * L
    const eyeY = (vh - L) / 2 + LM_EYE_RY * L
    const V = (LM_EYE_D * L) / VID_EYE_D       // 由眼距等比反算视频盒边长
    video.style.width = V + 'px'
    video.style.height = V + 'px'
    video.style.left = (eyeX - VID_EYE_RX * V) + 'px'
    video.style.top = (eyeY - VID_EYE_RY * V) + 'px'
  }

  let lmMount = null
  const startVideoFallback = () => {
    // 液态金属不可用：回退为渐显 + 立即起播（位置同样由 placeVideo 锚定）
    if (gone) return
    if (showShader) { try { showShader() } catch (_) {} }
    video.style.opacity = '1'
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(dismiss)
  }

  let handed = false
  const handoff = () => {
    // 单段式连续溶解：睁眼视频渐显 + 渐变底亮起 + 黑底液金层退场同步进行
    if (handed || gone) return
    handed = true
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
    video.style.transition = 'opacity ' + LM_FADE_MS + 'ms ease'
    lmWrap.style.transition = 'opacity ' + LM_FADE_MS + 'ms ease'
    if (showShader) { try { showShader() } catch (_) {} }
    requestAnimationFrame(() => {
      video.style.opacity = '1'
      lmWrap.style.opacity = '0'
    })
    setTimeout(() => {
      try { lmWrap.remove() } catch (_) {}
      if (lmMount) { try { lmMount.dispose() } catch (_) {} lmMount = null }
    }, LM_FADE_MS + 120)
  }

  // 挂载液态金属；成功返回 true。纹理加载失败/无 WebGL2 时返回 false 走回退。
  const runLiquidMetal = (texImg) => {
    const LM = window.__liaisonLiquidMetal
    if (!LM || gone) return false
    try {
      lmMount = new LM.ShaderMount(
        lmHost, LM.liquidMetalFragmentShader,
        {
          u_image: texImg,
          u_colorBack: LM.getShaderColorFromString('#000000'),
          u_colorTint: LM.getShaderColorFromString('#ffffff'),
          u_contour: 0.4, u_distortion: 0.07, u_softness: 0.1,
          u_repetition: 2, u_shiftRed: 0.3, u_shiftBlue: 0.3,
          u_angle: 70, u_isImage: true, u_shape: 0,
          u_fit: 1, u_scale: 0.3, u_rotation: 0,
          u_offsetX: 0, u_offsetY: 0, u_originX: 0.5, u_originY: 0.5,
          u_worldWidth: 0, u_worldHeight: 0,
        },
        { alpha: true }, 1, 0, 2, 2400000, ['u_image'],
      )
    } catch (_) { return false }
    setTimeout(handoff, LM_MS)
    return true
  }

  // ===== 流动渐变背景（WebGL shader）。失败即静默退回白 mask =====
  // 片元着色器来自设计稿：多色点位按距离幂加权混合 + 有机扭曲 + 旋涡。
  // 原稿是 WebGL2 写法（textureSize），这里适配成 WebGL1：分辨率走 u_resolution。
  let stopShader = null
  let showShader = null   // 快闪期间渐变底隐藏（开场直接首图），溶解阶段才随视频一起显出来
  try {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;margin:0;padding:0;border:0;opacity:0;transition:opacity 380ms ease;'
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
    if (gl) {
      const VERT = 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.,1.);}'
      const FRAG = [
        'precision highp float;',
        'uniform float u_time;',
        'uniform vec2 u_resolution;',
        'const float SPEED = 0.4;',
        'const float DISTORTION = 0.3;',
        'const float SWIRL = 0.4;',
        'const int COLOR_COUNT = 5;',
        'const float DIST_POWER = 4.0;',
        'const float GRAIN_MIXER = 0.2;',
        'const float GRAIN_OVERLAY = 0.0;',
        'const vec4 COLOR_0 = vec4(0.9255, 0.9882, 1.0000, 1.0000);',
        'const vec4 COLOR_1 = vec4(0.0000, 0.6667, 1.0000, 1.0000);',
        'const vec4 COLOR_2 = vec4(0.0000, 0.9686, 1.0000, 1.0000);',
        'const vec4 COLOR_3 = vec4(0.9255, 0.9882, 1.0000, 1.0000);',
        'const vec4 COLOR_4 = vec4(0.9255, 0.9882, 1.0000, 1.0000);',
        'const vec4 COLOR_5 = vec4(1.00, 1.00, 1.00, 1.00);',
        'float hash21(vec2 p){p=fract(p*vec2(0.3183099,0.3678794))+0.1;p+=dot(p,p+19.19);return fract(p.x*p.y);}',
        'float valueNoise(vec2 st){vec2 i=floor(st);vec2 f=fract(st);float a=hash21(i);float b=hash21(i+vec2(1.0,0.0));float c=hash21(i+vec2(0.0,1.0));float d=hash21(i+vec2(1.0,1.0));vec2 u=f*f*(3.0-2.0*f);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}',
        'vec2 rotate(vec2 uv,float th){return mat2(cos(th),sin(th),-sin(th),cos(th))*uv;}',
        'vec2 getPosition(int i,float t){float fi=float(i);float a=fi*0.37;float b=0.6+fract(fi/3.0)*0.9;float c=0.8+fract((fi+1.0)/4.0);float x=sin(t*b+a);float y=cos(t*c+a*1.5);return 0.5+0.5*vec2(x,y);}',
        'void main(){',
        '  vec2 uv = gl_FragCoord.xy / u_resolution;',
        '  float t = (u_time * 0.001 + 41.5) * SPEED;',
        '  vec2 grainUV = uv * 1000.0;',
        '  float grain = valueNoise(grainUV);',
        '  float mixerGrain = 0.4 * GRAIN_MIXER * (grain - 0.5);',
        '  float radius = smoothstep(0.0, 1.0, length(uv - 0.5));',
        '  float center = 1.0 - radius;',
        '  for (float i = 1.0; i <= 2.0; i++) {',
        '    uv.x += DISTORTION * center / i * sin(t + i * 0.4 * smoothstep(0.0, 1.0, uv.y)) * cos(0.2 * t + i * 2.4 * smoothstep(0.0, 1.0, uv.y));',
        '    uv.y += DISTORTION * center / i * cos(t + i * 2.0 * smoothstep(0.0, 1.0, uv.x));',
        '  }',
        '  vec2 uvRotated = uv - 0.5;',
        '  float angle = 3.0 * SWIRL * radius;',
        '  uvRotated = rotate(uvRotated, -angle);',
        '  uvRotated += 0.5;',
        '  vec3 color = vec3(0.0);',
        '  float opacity = 0.0;',
        '  float totalWeight = 0.0;',
        '  for (int i = 0; i < 6; i++) {',
        '    if (i >= COLOR_COUNT) break;',
        '    vec4 c;',
        '    if      (i == 0) c = COLOR_0;',
        '    else if (i == 1) c = COLOR_1;',
        '    else if (i == 2) c = COLOR_2;',
        '    else if (i == 3) c = COLOR_3;',
        '    else if (i == 4) c = COLOR_4;',
        '    else             c = COLOR_5;',
        '    vec2 pos = getPosition(i, t) + mixerGrain;',
        '    float dist = length(uvRotated - pos);',
        '    dist = pow(dist, DIST_POWER);',
        '    float weight = 1.0 / (dist + 1e-3);',
        '    color   += c.rgb * c.a * weight;',
        '    opacity += c.a * weight;',
        '    totalWeight += weight;',
        '  }',
        '  color   /= max(1e-4, totalWeight);',
        '  opacity /= max(1e-4, totalWeight);',
        '  float grainOverlay = valueNoise(rotate(grainUV, 1.0) + vec2(3.0));',
        '  grainOverlay = mix(grainOverlay, valueNoise(rotate(grainUV, 2.0) + vec2(-1.0)), 0.5);',
        '  grainOverlay = pow(grainOverlay, 1.3);',
        '  float grainOverlayV = grainOverlay * 2.0 - 1.0;',
        '  vec3  grainOverlayColor = vec3(step(0.0, grainOverlayV));',
        '  float grainOverlayStrength = GRAIN_OVERLAY * abs(grainOverlayV);',
        '  grainOverlayStrength = pow(grainOverlayStrength, 0.8);',
        '  color    = mix(color, grainOverlayColor, 0.35 * grainOverlayStrength);',
        '  opacity += 0.5 * grainOverlayStrength;',
        '  opacity  = clamp(opacity, 0.0, 1.0);',
        '  gl_FragColor = vec4(color, opacity);',
        '}',
      ].join('\n')
      const compile = (type, src) => {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed')
        return sh
      }
      const prog = gl.createProgram()
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program link failed')
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'a_pos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      const uTime = gl.getUniformLocation(prog, 'u_time')
      const uRes = gl.getUniformLocation(prog, 'u_resolution')
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const resize = () => {
        const w = Math.max(1, Math.round(window.innerWidth * dpr))
        const h = Math.max(1, Math.round(window.innerHeight * dpr))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
          gl.viewport(0, 0, w, h)
        }
      }
      resize()
      window.addEventListener('resize', resize)
      let raf = 0
      const t0 = performance.now()
      const frame = () => {
        resize()
        gl.uniform1f(uTime, performance.now() - t0)
        gl.uniform2f(uRes, canvas.width, canvas.height)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
      stopShader = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('resize', resize)
        const ext = gl.getExtension('WEBGL_lose_context')
        if (ext) { try { ext.loseContext() } catch (_) {} }
      }
      overlay.appendChild(canvas)
      showShader = () => { canvas.style.opacity = '1' }
      // 视频压在 canvas 上方（视频是 absolute 定位，z-index 高于 canvas 即可）
      video.style.zIndex = '1'
    }
  } catch (_) { stopShader = null }

  overlay.appendChild(video)

  let gone = false
  const dismiss = () => {
    if (gone) return
    gone = true
    overlay.style.opacity = '0'
    const hs = document.getElementById(HIDE_STYLE_ID)
    if (hs) hs.remove()   // 放出工具条
    setTimeout(() => {
      overlay.remove()
      if (stopShader) { try { stopShader() } catch (_) {} }
    }, 400)
  }

  window.addEventListener('resize', () => {
    if (gone) return
    const L = lmSize()
    lmHost.style.width = L + 'px'
    lmHost.style.height = L + 'px'
    placeVideo()
  })

  video.addEventListener('ended', dismiss)
  video.addEventListener('error', dismiss)
  overlay.addEventListener('click', dismiss)   // 点一下跳过
  setTimeout(dismiss, 9000)                    // 兜底：任何异常都不能把页面盖死（液金 2.6s + 溶解 .7s + 睁眼 3.5s）

  const mount = () => {
    overlay.appendChild(lmWrap)
    ;(document.body || document.documentElement).appendChild(overlay)
    placeVideo()
    // 渐显：下一帧再把透明度拉起来，让 transition 生效
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!gone) overlay.style.opacity = '1'
    }))
    // 纹理解码完成才起液态金属；失败或 1.5s 内没就绪，直接回退睁眼视频开场
    let started = false
    const begin = (ok, img) => {
      if (started || gone) return
      started = true
      if (ok && runLiquidMetal(img)) return
      try { lmWrap.remove() } catch (_) {}
      startVideoFallback()
    }
    const tex = new Image()
    tex.src = platform.runtime.getURL('toolbar/assets/cat-lm-tex.png')
    tex.decode().then(() => begin(true, tex), () => begin(false))
    setTimeout(() => begin(false), 1500)
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
