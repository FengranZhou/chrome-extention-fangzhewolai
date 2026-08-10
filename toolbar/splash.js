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

  // ===== 睁眼视频段 =====
  // 开场即播睁眼视频（液态金属与十图快闪两版前置阶段均已移除）。
  // 视频盒为正方形，边长取视口短边的一个比例，居中显示。
  const VID_SIZE_RATIO = 0.16   // 视频盒边长 / 视口短边

  const placeVideo = () => {
    const vw = window.innerWidth, vh = window.innerHeight
    const V = Math.round(Math.min(vw, vh) * VID_SIZE_RATIO)
    video.style.width = V + 'px'
    video.style.height = V + 'px'
    video.style.left = Math.round((vw - V) / 2) + 'px'
    video.style.top = Math.round((vh - V) / 2) + 'px'
  }

  // 开场：渐显 + 起播，同时亮起渐变底
  const startVideo = () => {
    if (gone) return
    if (showShader) { try { showShader() } catch (_) {} }
    video.style.opacity = '1'
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(dismiss)
  }

  // ===== Prism 棱镜背景（WebGL shader）。失败即静默退回纯黑底 =====
  // 移植自 React Bits 的 Prism 组件：raymarch 一个各向异性八面体的上半部（金字塔），
  // 沿射线累加正弦色带形成体积光。原实现依赖 React + ogl，这里剥离为原生 WebGL1。
  let stopShader = null
  let showShader = null   // 开场随睁眼视频一起淡入
  try {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;margin:0;padding:0;border:0;opacity:0;transition:opacity 380ms ease;'
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
    if (gl) {
      // 调参台定稿值
      const P_TIMESCALE = 0.3, P_HEIGHT = 1, P_BASEWIDTH = 2.3, P_SCALE = 3.4
      const P_OFFSET_Y = -47, P_HUESHIFT = 0.358, P_COLORFREQ = 0.9
      const P_GLOW = 1.5, P_BLOOM = 0.72, P_NOISE = 0, P_SATURATION = 1.3

      const VERT = 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.,1.);}'
      const FRAG = [
        'precision highp float;',
        'uniform vec2 iResolution;',
        'uniform float iTime;',
        'uniform float uHeight;',
        'uniform float uBaseHalf;',
        'uniform float uGlow;',
        'uniform vec2 uOffsetPx;',
        'uniform float uNoise;',
        'uniform float uSaturation;',
        'uniform float uHueShift;',
        'uniform float uColorFreq;',
        'uniform float uBloom;',
        'uniform float uCenterShift;',
        'uniform float uInvBaseHalf;',
        'uniform float uInvHeight;',
        'uniform float uMinAxis;',
        'uniform float uPxScale;',
        'uniform float uTimeScale;',
        'vec4 tanh4(vec4 x){ vec4 e2x = exp(2.0*x); return (e2x - 1.0) / (e2x + 1.0); }',
        'float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453123); }',
        'float sdOctaAnisoInv(vec3 p){',
        '  vec3 q = vec3(abs(p.x)*uInvBaseHalf, abs(p.y)*uInvHeight, abs(p.z)*uInvBaseHalf);',
        '  float m = q.x + q.y + q.z - 1.0;',
        '  return m * uMinAxis * 0.5773502691896258;',
        '}',
        'float sdPyramidUpInv(vec3 p){ return max(sdOctaAnisoInv(p), -p.y); }',
        'mat3 hueRotation(float a){',
        '  float c = cos(a), s = sin(a);',
        '  mat3 W = mat3(0.299,0.587,0.114, 0.299,0.587,0.114, 0.299,0.587,0.114);',
        '  mat3 U = mat3(0.701,-0.587,-0.114, -0.299,0.413,-0.114, -0.300,-0.588,0.886);',
        '  mat3 V = mat3(0.168,-0.331,0.500, 0.328,0.035,-0.500, -0.497,0.296,0.201);',
        '  return W + U*c + V*s;',
        '}',
        'void main(){',
        '  vec2 f = (gl_FragCoord.xy - 0.5*iResolution.xy - uOffsetPx) * uPxScale;',
        '  float z = 5.0;',
        '  float d = 0.0;',
        '  vec3 p;',
        '  vec4 o = vec4(0.0);',
        // animationType=rotate：只做 shader 内 base wobble，不做整体旋转
        '  float t = iTime * uTimeScale;',
        '  float c0 = cos(t), c1 = cos(t + 33.0), c2 = cos(t + 11.0);',
        '  mat2 wob = mat2(c0, c1, c2, c0);',
        '  for (int i = 0; i < 100; i++) {',
        '    p = vec3(f, z);',
        '    p.xz = wob * p.xz;',
        '    vec3 q = p;',
        '    q.y += uCenterShift;',
        '    d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));',
        '    z -= d;',
        '    o += (sin((p.y + z) * uColorFreq + vec4(0.0,1.0,2.0,3.0)) + 1.0) / d;',
        '  }',
        '  o = tanh4(o * o * (uGlow * uBloom) / 1e5);',
        '  vec3 col = o.rgb;',
        '  if (uNoise > 0.000001) col += (rand(gl_FragCoord.xy + vec2(iTime)) - 0.5) * uNoise;',
        '  col = clamp(col, 0.0, 1.0);',
        '  float L = dot(col, vec3(0.2126,0.7152,0.0722));',
        '  col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);',
        '  if (abs(uHueShift) > 0.0001) col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);',
        '  gl_FragColor = vec4(col, 1.0);',
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

      const U = (n) => gl.getUniformLocation(prog, n)
      const uRes = U('iResolution'), uTime = U('iTime'), uPxScale = U('uPxScale')
      const uOffsetPx = U('uOffsetPx')
      const H = Math.max(0.001, P_HEIGHT), BH = Math.max(0.001, P_BASEWIDTH) * 0.5
      // 与分辨率无关的常量只需设一次
      gl.uniform1f(U('uHeight'), H)
      gl.uniform1f(U('uBaseHalf'), BH)
      gl.uniform1f(U('uGlow'), P_GLOW)
      gl.uniform1f(U('uNoise'), P_NOISE)
      gl.uniform1f(U('uSaturation'), P_SATURATION)
      gl.uniform1f(U('uHueShift'), P_HUESHIFT)
      gl.uniform1f(U('uColorFreq'), P_COLORFREQ)
      gl.uniform1f(U('uBloom'), P_BLOOM)
      gl.uniform1f(U('uCenterShift'), H * 0.25)
      gl.uniform1f(U('uInvBaseHalf'), 1 / BH)
      gl.uniform1f(U('uInvHeight'), 1 / H)
      gl.uniform1f(U('uMinAxis'), Math.min(BH, H))
      gl.uniform1f(U('uTimeScale'), P_TIMESCALE)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const resize = () => {
        const w = Math.max(1, Math.round(window.innerWidth * dpr))
        const h = Math.max(1, Math.round(window.innerHeight * dpr))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
          gl.viewport(0, 0, w, h)
        }
        gl.uniform2f(uRes, canvas.width, canvas.height)
        gl.uniform2f(uOffsetPx, 0, P_OFFSET_Y * dpr)
        // uPxScale 依赖 drawingBuffer 高度，必须随尺寸重算
        gl.uniform1f(uPxScale, 1 / ((canvas.height || 1) * 0.1 * Math.max(0.001, P_SCALE)))
      }
      resize()
      window.addEventListener('resize', resize)
      let raf = 0
      const t0 = performance.now()
      const frame = () => {
        resize()
        gl.uniform1f(uTime, (performance.now() - t0) * 0.001)
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
    placeVideo()
  })

  video.addEventListener('ended', dismiss)
  video.addEventListener('error', dismiss)
  overlay.addEventListener('click', dismiss)   // 点一下跳过
  setTimeout(dismiss, 6000)                    // 兜底：任何异常都不能把页面盖死（渐显 .7s + 睁眼 3.5s）

  const mount = () => {
    ;(document.body || document.documentElement).appendChild(overlay)
    placeVideo()
    // 渐显：下一帧再把透明度拉起来，让 transition 生效
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!gone) overlay.style.opacity = '1'
      startVideo()
    }))
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
