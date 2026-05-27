/* NEO Radar — heliocentric Canvas2D renderer
   Runs in the browser. Receives immutable state[] arrays from the physics
   engine via the page's inline data bridge — ZERO imports from src/physics/.

   state[]: Array of {
     pos:       [x, y, z]   AU heliocentric ecliptic
     vel:       [vx, vy, vz]
     name:      string
     riskLevel: 'safe' | 'monitor' | 'caution' | 'hazardous'
     trail?:    [[x,y,z], ...]
   }
*/

const RISK_COLOR = {
  safe:      '#2fd07a',
  monitor:   '#6fb4ff',
  caution:   '#f5c542',
  hazardous: '#ff3b50',
};

class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.scale   = 180;  // px per AU
    this.showLabels = true;
    this.showTrails = true;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.canvas.width  = this.canvas.offsetWidth  * devicePixelRatio;
    this.canvas.height = this.canvas.offsetHeight * devicePixelRatio;
    this.cx = this.canvas.width  / 2;
    this.cy = this.canvas.height / 2;
  }

  _toScreen(pos) {
    return {
      x: this.cx + pos[0] * this.scale * devicePixelRatio,
      y: this.cy - pos[1] * this.scale * devicePixelRatio,
    };
  }

  render(states) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawGrid();
    this._drawSun();
    for (const s of states) {
      if (this.showTrails && s.trail) this._drawTrail(s);
      this._drawObject(s);
    }
  }

  _drawGrid() {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    // 1 AU ring guides
    for (const r of [1, 2, 3]) {
      const pr = r * this.scale * devicePixelRatio;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, pr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSun() {
    const { ctx } = this;
    const s  = this._toScreen([0, 0, 0]);
    const px = 14 * devicePixelRatio;
    const g  = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, px);
    g.addColorStop(0,   '#ffe7a8');
    g.addColorStop(0.3, '#ffb84d');
    g.addColorStop(1,   'transparent');
    ctx.beginPath();
    ctx.arc(s.x, s.y, px, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  _drawTrail(state) {
    const { ctx } = this;
    const color = RISK_COLOR[state.riskLevel] || '#f0f4ff';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth   = 1 * devicePixelRatio;
    ctx.beginPath();
    state.trail.forEach((pt, i) => {
      const s = this._toScreen(pt);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  _drawObject(state) {
    const { ctx } = this;
    const s     = this._toScreen(state.pos);
    const color = RISK_COLOR[state.riskLevel] || '#f0f4ff';
    const r     = 3.5 * devicePixelRatio;

    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor  = color;
    ctx.shadowBlur   = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (this.showLabels) {
      ctx.fillStyle = 'rgba(240,244,255,0.7)';
      ctx.font      = `${10 * devicePixelRatio}px "JetBrains Mono", monospace`;
      ctx.fillText(state.name, s.x + r + 4, s.y + 4);
    }
  }
}
