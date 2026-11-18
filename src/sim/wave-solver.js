// Real-time 2D wave solver on the GPU (WebGL2).
//
// It solves the scalar wave equation with damping,
//
//     u_tt + 2 g u_t = c^2 (u_xx + u_yy) + coupling to the levels above and below
//
// with the standard explicit finite-difference time-domain (FDTD) leapfrog scheme:
//
//     u_next = ( 2 u - (1 - g) u_prev + C^2 * laplacian(u) + Cz^2 * vertical(u) + source ) / (1 + g)
//
// where C = c * dt / dx is the Courant number of the cell and g its damping per step.
// Stability (CFL condition): 4 C^2 + 2 Cz^2 <= 2. With C = 0.5 in air (the highest
// value anywhere) and Cz^2 = 0.15 the left side is 1.3.
//
// State lives in two float textures that swap roles every step ("ping-pong"):
//     R = u at the current step, G = u at the previous step,
//     B = running average of u^2 (the envelope), A = unused.
// A third, small texture holds the envelope averaged over 8 x 8 cells for the display.
// The medium texture (see rasterize.js) holds C^2, g and the stair coupling.
// All levels sit in one texture, one tile per level stacked along y.
//
// The outer ring of every tile is held at zero and the cells before it are a
// damping sponge, so waves that leave the house are absorbed and tiles do not
// leak into each other.
//
// This module uses raw WebGL2 and knows nothing about Three.js or the floor plan.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const MAX_SOURCES = 24;

const STEP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uMedium;
uniform ivec2 uTile;
uniform float uCouple;
uniform float uEnvRate;
uniform float uSrcGain;
uniform int uSrcCount;
uniform vec4 uSrc[${MAX_SOURCES}];      // x, y (atlas cells), amplitude, phase at this step
uniform float uSrcSigma[${MAX_SOURCES}];
out vec4 outState;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int ly = p.y % uTile.y;
  vec4 s = texelFetch(uState, p, 0);
  if (p.x == 0 || p.x == uTile.x - 1 || ly == 0 || ly == uTile.y - 1) {
    outState = vec4(0.0, 0.0, s.b * (1.0 - uEnvRate), 0.0);
    return;
  }
  vec4 m = texelFetch(uMedium, p, 0);
  float u = s.r;
  float lap = texelFetch(uState, p + ivec2(1, 0), 0).r + texelFetch(uState, p - ivec2(1, 0), 0).r
            + texelFetch(uState, p + ivec2(0, 1), 0).r + texelFetch(uState, p - ivec2(0, 1), 0).r - 4.0 * u;
  float vert = 0.0;
  if (m.b > 0.0) vert += m.b * (texelFetch(uState, p + ivec2(0, uTile.y), 0).r - u);
  if (m.a > 0.0) vert += m.a * (texelFetch(uState, p - ivec2(0, uTile.y), 0).r - u);
  float src = 0.0;
  vec2 c = vec2(p) + 0.5;
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    if (i >= uSrcCount) break;
    vec2 d = c - uSrc[i].xy;
    float sg = uSrcSigma[i];
    float r2 = dot(d, d);
    if (r2 < 16.0 * sg * sg) src += uSrc[i].z * exp(-r2 / (2.0 * sg * sg)) * sin(uSrc[i].w);
  }
  float g = m.g;
  float un = (2.0 * u - (1.0 - g) * s.g + m.r * lap + uCouple * vert + uSrcGain * src) / (1.0 + g);
  outState = vec4(un, u, mix(s.b, un * un, uEnvRate), 0.0);
}`;

// Averages over blocks of 8 x 8 cells into a small texture, for the display:
//   R   the envelope (state channel B): the local signal level of the wave field
//   G,B the energy flow, averaged over time. For a wave u the flow of energy is
//       -u_t * grad(u). It points where the wave travels and it cancels in a standing
//       wave, so its time average shows where signal actually goes.
//   A   C * |grad u|^2 averaged the same way. A wave that only travels one way has
//       |flow| = A, so |flow| / A says how directed the field is (1) or how much it
//       only sloshes back and forth (0).
// Sixteen bilinear taps cover the block exactly, so no mipmap generation is needed.
const ENV_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uPrevEnv;
uniform vec2 uLowSize;
uniform vec2 uTexel;
uniform float uFlowRate;
uniform float uCourant;
out vec4 outEnv;
void main() {
  vec2 uv = gl_FragCoord.xy / uLowSize;
  float sum = 0.0, grad2 = 0.0;
  vec2 flow = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 p = uv + (vec2(float(i), float(j)) * 2.0 - 3.0) * uTexel;
      vec4 s = texture(uState, p);
      sum += s.b;
      vec2 g = 0.5 * vec2(texture(uState, p + vec2(uTexel.x, 0.0)).r - texture(uState, p - vec2(uTexel.x, 0.0)).r,
                          texture(uState, p + vec2(0.0, uTexel.y)).r - texture(uState, p - vec2(0.0, uTexel.y)).r);
      flow -= (s.r - s.g) * g;
      grad2 += dot(g, g);
    }
  }
  vec4 prev = texture(uPrevEnv, uv);
  outEnv = vec4(sum / 16.0, mix(prev.gb, flow / 16.0, uFlowRate), mix(prev.a, uCourant * grad2 / 16.0, uFlowRate));
}`;

export const ENV_DOWNSCALE = 8;

function link(gl, fragSource) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, fragSource);
  gl.attachShader(program, vs); gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`wave solver: program did not link: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vs); gl.deleteShader(fs);
  return program;
}

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`wave solver: shader did not compile: ${log}`);
  }
  return sh;
}

/**
 * Phase of the carrier inside a pulse, for step t of `lengthSteps`.
 *
 * A pulse holds a whole number of wave periods (two or more), and the carrier is a cosine
 * around the middle of the pulse. With the smooth window sin^2 around it, the sum of the
 * pulse over time is then exactly zero, and so is its first moment. In plain words: the
 * pulse pushes the field up exactly as much as it pulls it down, and it does so evenly
 * around its middle. A pulse that does not (1.5 periods, for example) leaves the whole
 * floor shifted to one side after it has passed.
 * The shader takes sin(phase), so a quarter turn is added to get the cosine.
 */
function pulsePhase(t, lengthSteps, omegaDt) {
  const cycles = Math.max(2, Math.round((lengthSteps * omegaDt) / (Math.PI * 2)));
  return (Math.PI * 2 * cycles * (t - lengthSteps / 2)) / lengthSteps + Math.PI / 2;
}

export class WaveSolver {
  /** Null when the browser can run the solver, else a sentence that says what is missing. */
  static unsupportedReason(gl) {
    if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return 'WebGL2 is not available';
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return 'the GPU cannot render to float textures';
    return null;
  }

  /**
   * gl: WebGL2 context. nx, ny: cells of one tile. levels: number of tiles.
   * precision: 'auto' | 'float32' | 'float16'.
   */
  constructor(gl, { nx, ny, levels = 1, precision = 'auto' }) {
    const why = WaveSolver.unsupportedReason(gl);
    if (why) throw new Error(`wave solver: ${why}`);
    this.gl = gl;
    this.nx = nx; this.ny = ny; this.levels = levels;
    this.width = nx; this.height = ny * levels;
    const full = !!gl.getExtension('EXT_color_buffer_float');
    const linear = !!gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_half_float');
    // 32-bit floats when they can be rendered to and filtered; else 16-bit, which always filters.
    this.float32 = precision === 'float32' ? full : precision === 'float16' ? false : full && linear;
    this.filterable = this.float32 ? linear : true;
    this.internalFormat = this.float32 ? gl.RGBA32F : gl.RGBA16F;

    this.program = link(gl, STEP_FRAG);
    this.envProgram = link(gl, ENV_FRAG);
    this.envUni = {};
    for (const name of ['uState', 'uPrevEnv', 'uLowSize', 'uTexel', 'uFlowRate', 'uCourant']) this.envUni[name] = gl.getUniformLocation(this.envProgram, name);
    this.uni = {};
    for (const name of ['uState', 'uMedium', 'uTile', 'uCouple', 'uEnvRate', 'uSrcGain', 'uSrcCount', 'uSrc', 'uSrcSigma']) {
      this.uni[name] = gl.getUniformLocation(this.program, name);
    }
    this.vao = gl.createVertexArray();

    this.textures = [this._makeState(), this._makeState()];
    this.fbos = this.textures.map((tex) => {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('wave solver: float framebuffer is not complete');
      return fbo;
    });
    // Small averaged copy of the envelope and the energy flow, always 16-bit float so that it
    // filters on every GPU. Two textures that swap roles, because the flow is a running average.
    this.envWidth = Math.ceil(this.width / ENV_DOWNSCALE);
    this.envHeight = Math.ceil(this.height / ENV_DOWNSCALE);
    this.envTextures = [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.envWidth, this.envHeight);
      return tex;
    });
    this.envFbos = this.envTextures.map((tex) => {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('wave solver: envelope framebuffer is not complete');
      return fbo;   // a new texture starts as zeros, so the running average starts at zero
    });
    this.envFront = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.medium = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.medium);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.front = 0;            // index of the texture that holds the current state
    this.stepCount = 0;
    this.phase = 0;
    this.params = { omegaDt: 0.15, coupling: 0.15, envelopeRate: 0.01, sourceGain: 0.25 };
    this.srcData = new Float32Array(MAX_SOURCES * 4);
    this.srcSigma = new Float32Array(MAX_SOURCES).fill(1.5);
    this.srcPhase0 = new Float64Array(MAX_SOURCES);
    this.srcFreq = new Float64Array(MAX_SOURCES).fill(1);
    this.srcAmp = new Float64Array(MAX_SOURCES);
    this.srcPulse = new Array(MAX_SOURCES).fill(null);   // null = continuous tone, else { period, offset, length } in steps
    this.srcCount = 0;
    this.baseCount = 0;
    this.bursts = [];
    this.mediumData = null;
    this.reset();
  }

  _makeState() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const lin = this.filterable;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.internalFormat, this.width, this.height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /** The WebGL texture with the current state. It changes after every step. */
  get texture() { return this.textures[this.front]; }
  get mediumTexture() { return this.medium; }
  /** The WebGL texture with the envelope (R) and the energy flow (G, B, A) averaged over 8 x 8 cells. Call updateEnvelopeMap() first. It changes after every update. */
  get envelopeTexture() { return this.envTextures[this.envFront]; }

  setParams(p) { Object.assign(this.params, p); }

  /** data: Float32Array(nx * ny * levels * 4) from rasterizeMedium(). */
  setMedium(data) {
    const gl = this.gl;
    if (data.length !== this.width * this.height * 4) throw new Error('wave solver: medium has the wrong size');
    this.mediumData = data;
    gl.bindTexture(gl.TEXTURE_2D, this.medium);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * sources: [{ x, y, level, amp, phase, sigma, freq, pulse }] with x, y in cells inside the tile of that level.
   * freq multiplies the base frequency (default 1).
   * pulse: { period, offset, length } in time steps. The source is silent except for one
   * short wave packet per period, `length` steps long, that starts `offset` steps into
   * the period. Without pulse the source is a continuous tone.
   */
  setSources(sources) {
    this.baseCount = Math.min(MAX_SOURCES, sources.length);
    for (let i = 0; i < this.baseCount; i++) {
      const s = sources[i];
      this.srcData[i * 4] = s.x;
      this.srcData[i * 4 + 1] = s.y + (s.level || 0) * this.ny;
      this.srcAmp[i] = s.amp ?? 1;
      this.srcData[i * 4 + 2] = this.srcAmp[i];
      this.srcPhase0[i] = s.phase ?? 0;
      this.srcFreq[i] = s.freq ?? 1;
      this.srcSigma[i] = s.sigma ?? 1.5;
      this.srcPulse[i] = s.pulse && s.pulse.period > 0 && s.pulse.length > 0 ? { period: s.pulse.period, offset: s.pulse.offset || 0, length: s.pulse.length } : null;
    }
    this.srcCount = this.baseCount;
  }

  /**
   * One short wave packet from a place, once: { x, y, level, amp, sigma, length }.
   * It uses a free source slot until it has finished. When no slot is free it is dropped.
   */
  addBurst(b) {
    if (this.baseCount + this.bursts.length >= MAX_SOURCES) return false;
    this.bursts.push({ x: b.x, y: b.y + (b.level || 0) * this.ny, amp: b.amp ?? 0.5, sigma: b.sigma ?? 1.5, length: Math.max(4, Math.round(b.length || 40)), start: this.stepCount });
    return true;
  }

  /** Amplitude and phase of every source at the current step, written into srcData. */
  _driveSources() {
    const w = this.params.omegaDt, TWO_PI = Math.PI * 2;
    // a continuous tone fades in over one period, so that a restart does not make a hard click.
    // A pulse has its own smooth window and must not be faded: that would unbalance it.
    const fadeIn = Math.min(1, (this.stepCount * w) / TWO_PI);
    for (let k = 0; k < this.baseCount; k++) {
      const p = this.srcPulse[k];
      if (!p) {
        this.srcData[k * 4 + 2] = this.srcAmp[k] * fadeIn;
        this.srcData[k * 4 + 3] = (this.phase * this.srcFreq[k] + this.srcPhase0[k]) % TWO_PI;
        continue;
      }
      const t = (((this.stepCount - p.offset) % p.period) + p.period) % p.period;
      if (t < p.length) {
        const window = Math.sin((Math.PI * t) / p.length);
        this.srcData[k * 4 + 2] = this.srcAmp[k] * window * window;
        this.srcData[k * 4 + 3] = pulsePhase(t, p.length, w * this.srcFreq[k]);
      } else this.srcData[k * 4 + 2] = 0;
    }
    this.bursts = this.bursts.filter((b) => this.stepCount - b.start < b.length);
    let k = this.baseCount;
    for (const b of this.bursts) {
      if (k >= MAX_SOURCES) break;
      const t = this.stepCount - b.start;
      const window = Math.sin((Math.PI * t) / b.length);
      this.srcData[k * 4] = b.x; this.srcData[k * 4 + 1] = b.y;
      this.srcData[k * 4 + 2] = b.amp * window * window;
      this.srcData[k * 4 + 3] = pulsePhase(t, b.length, w);
      this.srcSigma[k] = b.sigma;
      k++;
    }
    this.srcCount = k;
  }

  /** Set the whole field to zero and restart the source phase. */
  reset() {
    this.setState(null, null);
    this.stepCount = 0;
    this.phase = 0;
    this.bursts = [];
    // the running average of the energy flow starts again too, or the arrows would show the old field for a while
    const gl = this.gl;
    const zeros = new Uint16Array(this.envWidth * this.envHeight * 4);
    for (const tex of this.envTextures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.envWidth, this.envHeight, gl.RGBA, gl.HALF_FLOAT, zeros);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Load a field. u, uPrev: Float32Array(nx * ny * levels) or null for zero. */
  setState(u, uPrev) {
    const gl = this.gl;
    const n = this.width * this.height;
    const buf = new Float32Array(n * 4);
    if (u) for (let i = 0; i < n; i++) { buf[i * 4] = u[i]; buf[i * 4 + 1] = uPrev ? uPrev[i] : u[i]; }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const tex of this.textures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, buf);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Advance n time steps. Leaves the default framebuffer bound; other GL state is changed. */
  step(n = 1) {
    if (n <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.uniform1i(this.uni.uState, 0);
    gl.uniform1i(this.uni.uMedium, 1);
    gl.uniform2i(this.uni.uTile, this.nx, this.ny);
    gl.uniform1f(this.uni.uCouple, this.params.coupling);
    gl.uniform1f(this.uni.uEnvRate, this.params.envelopeRate);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.medium);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < n; i++) {
      this.stepCount++;
      this.phase += this.params.omegaDt;      // kept in double precision; each source gets its own phase from it
      this._driveSources();
      gl.uniform1i(this.uni.uSrcCount, this.srcCount);
      gl.uniform1fv(this.uni.uSrcSigma, this.srcSigma);
      gl.uniform4fv(this.uni.uSrc, this.srcData);
      gl.uniform1f(this.uni.uSrcGain, this.params.sourceGain);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[this.front]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1 - this.front]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.front = 1 - this.front;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  /**
   * Refresh the small averaged envelope and energy-flow texture from the current state. One cheap pass.
   * flowRate (0..1) is how fast the running average of the energy flow follows the field.
   */
  updateEnvelopeMap(flowRate = 0.05) {
    const gl = this.gl;
    gl.useProgram(this.envProgram);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.envWidth, this.envHeight);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.uniform1i(this.envUni.uState, 0);
    gl.uniform2f(this.envUni.uLowSize, this.envWidth, this.envHeight);
    gl.uniform2f(this.envUni.uTexel, 1 / this.width, 1 / this.height);
    gl.uniform1i(this.envUni.uPrevEnv, 1);
    gl.uniform1f(this.envUni.uFlowRate, Math.min(1, Math.max(0, flowRate)));
    gl.uniform1f(this.envUni.uCourant, this.params.courant ?? 0.5);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.envTextures[this.envFront]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.front]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.envFbos[1 - this.envFront]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.envFront = 1 - this.envFront;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
  }

  /** Read the small envelope and flow texture back. Slow; meant for tests. Returns Float32Array(envWidth * envHeight * 4). */
  readEnvelopeMap() {
    const gl = this.gl;
    const buf = new Float32Array(this.envWidth * this.envHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.envFbos[this.envFront]);
    gl.readPixels(0, 0, this.envWidth, this.envHeight, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }

  /** Read the state back. Slow; meant for tests. Returns { u, uPrev, env }. */
  readState() {
    const gl = this.gl;
    const n = this.width * this.height;
    const buf = new Float32Array(n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.front]);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const u = new Float32Array(n), uPrev = new Float32Array(n), env = new Float32Array(n);
    for (let i = 0; i < n; i++) { u[i] = buf[i * 4]; uPrev[i] = buf[i * 4 + 1]; env[i] = buf[i * 4 + 2]; }
    return { u, uPrev, env };
  }

  /** Value of u in one cell (x, y in atlas cells). Slow; meant for tests. */
  readCell(x, y) {
    const gl = this.gl;
    const px = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.front]);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px[0];
  }

  /**
   * Discrete energy of the field. For the leapfrog scheme without damping and
   * without sources this number is constant from step to step:
   *   E = sum over cells of (u - uPrev)^2 / C^2
   *     + sum over neighbour pairs of (u_i - u_j) * (uPrev_i - uPrev_j)
   *     + the same pair term for coupled stair cells, scaled by Cz^2 / C^2.
   */
  energy(state = this.readState()) {
    const { u, uPrev } = state;
    const m = this.mediumData;
    const W = this.width, H = this.height;
    let e = 0;
    for (let y = 0; y < H; y++) {
      const ly = y % this.ny;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const c2 = m[i * 4];
        const dv = u[i] - uPrev[i];
        if (c2 > 1e-9) e += (dv * dv) / c2;
        if (x + 1 < W) e += (u[i] - u[i + 1]) * (uPrev[i] - uPrev[i + 1]);
        if (ly + 1 < this.ny) e += (u[i] - u[i + W]) * (uPrev[i] - uPrev[i + W]);
        if (m[i * 4 + 2] > 0 && y + this.ny < H) {
          const j = i + this.ny * W;
          e += ((this.params.coupling * m[i * 4 + 2]) / c2) * (u[i] - u[j]) * (uPrev[i] - uPrev[j]);
        }
      }
    }
    return e;
  }

  dispose() {
    const gl = this.gl;
    this.textures.forEach((t) => gl.deleteTexture(t));
    this.fbos.forEach((f) => gl.deleteFramebuffer(f));
    gl.deleteTexture(this.medium);
    this.envTextures.forEach((t) => gl.deleteTexture(t));
    this.envFbos.forEach((f) => gl.deleteFramebuffer(f));
    gl.deleteProgram(this.envProgram);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
