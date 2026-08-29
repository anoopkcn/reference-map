import type { MainToWorker, WorkerToMain } from './protocol';
import { SimulationCore } from './simulationCore';

const post = (msg: WorkerToMain, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer ?? []);

let core = new SimulationCore();
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const free: Float32Array[] = [];
let outstanding = 0;
const MAX_OUTSTANDING = 2;
const TICK_MS = 16;

function takeBuffer(): Float32Array {
  const need = 2 * core.count;
  while (free.length) {
    const b = free.pop()!;
    if (b.length >= need) return b;
  }
  return new Float32Array(2 * (core.count + 256));
}

function postPositions(alpha: number, force = false): void {
  if (!force && outstanding >= MAX_OUTSTANDING) return;
  const buf = takeBuffer();
  core.writePositions(buf);
  outstanding++;
  post({ t: 'tick', pos: buf, n: core.count, alpha }, [buf.buffer]);
}

function loop(): void {
  timer = null;
  if (!running) return;
  if (core.count === 0 || core.alpha < core.alphaMin) {
    running = false;
    postPositions(core.alpha, true);
    post({ t: 'end' });
    return;
  }
  const alpha = core.tick();
  postPositions(alpha);
  timer = setTimeout(loop, TICK_MS);
}

function start(): void {
  if (running) return;
  running = true;
  if (!timer) timer = setTimeout(loop, 0);
}

function stop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case 'init':
      stop();
      core = new SimulationCore(m.params);
      post({ t: 'ready' });
      break;
    case 'addNodes':
      core.addNodes(m.r, m.x, m.y);
      core.reheat(0.5);
      start();
      break;
    case 'addLinks':
      core.addLinks(m.src, m.dst);
      core.reheat(0.4);
      start();
      break;
    case 'setRadii':
      core.setRadii(m.r);
      core.reheat(0.1);
      start();
      break;
    case 'reset':
      core.reset(m.r, m.x, m.y, m.pinned, m.src, m.dst);
      core.reheat(0.5);
      start();
      break;
    case 'drag':
      core.drag(m.idx, m.x, m.y);
      start();
      break;
    case 'dragEnd':
      core.dragEnd(m.idx, m.pin);
      start();
      break;
    case 'pin':
      core.pin(m.idx, m.x, m.y);
      postPositions(core.alpha, true);
      break;
    case 'unpin':
      core.unpin(m.idx);
      core.reheat(0.2);
      start();
      break;
    case 'unpinAll':
      core.unpinAll();
      core.reheat(0.3);
      start();
      break;
    case 'mode':
      core.setMode(m.mode);
      core.reheat(0.5); // big rearrangement — same scale as reset/addNodes
      start();
      break;
    case 'targets':
      core.setTargets(m.x, m.y);
      core.reheat(0.3); // local adjustment; also covers lazily arriving years
      start();
      break;
    case 'reheat':
      core.reheat(m.alpha);
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'buffer':
      outstanding = Math.max(0, outstanding - 1);
      free.push(m.pos);
      break;
  }
};

post({ t: 'ready' });
