// Package tmt provides a thread-safe Ternary Mesh Tree with BLAKE3 hashing,
// compact proofs, optional hash caching, metrics, and JSON-based serialization.
//
// Usage:
//
//	const tree = new TernaryMeshTree();
//	await tree.build([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
//	const [ok, err] = await tree.verify(0, new Uint8Array([1, 2, 3]));

import { hash as blake3 } from 'blake3';

export type Hash = Uint8Array; // 32 bytes
export type NodeID = number;

// ---------------------- Hash utilities ----------------------

export function computeHash(data: Uint8Array): Hash {
  return new Uint8Array(blake3(data) as Hash);
}

export function combineHashes(hashes: Hash[]): Hash {
  const combined = new Uint8Array(hashes.length * 32);
  for (let i = 0; i < hashes.length; i++) {
    combined.set(hashes[i], i * 32);
  }
  return new Uint8Array(blake3(combined) as Hash);
}

export function hashToHex(h: Hash): string {
  return Array.from(h)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hashesEqual(a: Hash, b: Hash): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------- Serializable & internal nodes ----------------------

export interface SerializableNode {
  id: NodeID;
  hash: number[]; // Hash as array for JSON serialization
  children: NodeID[]; // empty for leaves, up to 3 for internals
  isLeaf: boolean;
  parent: NodeID | null;
}

interface InternalNode {
  hash: Hash;
  children: NodeID[];
  isLeaf: boolean;
  parent: NodeID | null;
}

interface SerializedBlob {
  nodes: SerializableNode[];
  leafData: number[][]; // Uint8Array as number array for JSON
  rootID: NodeID | null;
  leafCount: number;
}

// ---------------------- Verification proof ----------------------

export interface SiblingHash {
  pos: number;
  hash: Hash;
}

export interface VerificationProof {
  leafIndex: number;
  siblingHashes: SiblingHash[]; // (position, hash) pairs
  pathLength: number;
}

// ---------------------- Metrics ----------------------

export interface Metrics {
  buildTimeMS: number;
  lastVerificationTimeNS: number;
  lastUpdateTimeNS: number;
  totalVerifications: number;
  totalUpdates: number;
  memoryUsageBytes: number;
}

// ---------------------- Config ----------------------

export interface Config {
  enableCaching: boolean;
  maxCacheSize: number;
  enableMetrics: boolean;
  parallelThreshold: number; // chunked parallel pre-hash when leaves >= this
}

export function defaultConfig(): Config {
  return {
    enableCaching: true,
    maxCacheSize: 10_000,
    enableMetrics: true,
    parallelThreshold: 1000,
  };
}

// ---------------------- Errors ----------------------

export class TMTError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TMTError';
  }
}

export const ErrorMessages = {
  EMPTY_DATA: 'cannot build tree from empty data',
  INVALID_INDEX: 'invalid index',
  UNINITIALIZED: 'tree is not initialized',
  SERIALIZATION: 'serialization error',
  INVALID_PROOF: 'invalid proof',
  MISSING_PARENT: 'missing parent while walking upward',
} as const;

// ---------------------- TernaryMeshTree ----------------------

export class TernaryMeshTree {
  private nodes: InternalNode[] = [];
  private leafData: Uint8Array[] = [];
  private rootID: NodeID | null = null;
  private leafCount = 0;
  private cfg: Config;
  private metrics: Metrics;
  private hashCache = new Map<string, Hash>();

  constructor(cfg: Config = defaultConfig()) {
    this.cfg = cfg;
    this.metrics = {
      buildTimeMS: 0,
      lastVerificationTimeNS: 0,
      lastUpdateTimeNS: 0,
      totalVerifications: 0,
      totalUpdates: 0,
      memoryUsageBytes: 0,
    };
  }

  // ---------------------- Build ----------------------

  async build(dataBlocks: Uint8Array[]): Promise<void> {
    const start = performance.now();

    if (dataBlocks.length === 0) {
      throw new TMTError(ErrorMessages.EMPTY_DATA);
    }

    // reset old state
    this.nodes = [];
    this.leafData = [];
    this.leafCount = dataBlocks.length;
    this.rootID = null;

    // leaves
    let current: NodeID[] = [];
    for (let i = 0; i < dataBlocks.length; i++) {
      const d = dataBlocks[i];
      const h = await this.getCachedHash(d);
      this.nodes.push({
        hash: h,
        children: [],
        isLeaf: true,
        parent: null,
      });
      this.leafData.push(new Uint8Array(d));
      current.push(i);
    }

    // pad to divisible by 3
    while (current.length % 3 !== 0) {
      const h = computeHash(new Uint8Array(0));
      this.nodes.push({ hash: h, children: [], isLeaf: true, parent: null });
      this.leafData.push(new Uint8Array(0));
      current.push(this.nodes.length - 1);
    }

    // helper to append a parent
    const appendParent = (chunk: NodeID[], parentHash: Hash): NodeID => {
      const p: InternalNode = {
        hash: parentHash,
        children: [...chunk],
        isLeaf: false,
        parent: null,
      };
      const pid = this.nodes.length;
      this.nodes.push(p);
      for (const cid of chunk) {
        this.nodes[cid].parent = pid;
      }
      return pid;
    };

    // bottom-up
    while (current.length > 1) {
      const next: NodeID[] = [];

      // optional parallel pre-hash of child groups
      if (this.cfg.parallelThreshold > 0 && current.length >= this.cfg.parallelThreshold) {
        const chunks = chunkBy(current, 3);
        const promises = chunks.map(async (chunk, i) => {
          const childHashes: Hash[] = [];
          for (const id of chunk) {
            childHashes.push(this.nodes[id].hash);
          }
          return {
            i,
            chunk,
            hash: combineHashes(childHashes),
          };
        });

        const precomp = await Promise.all(promises);
        precomp.sort((a, b) => a.i - b.i);
        for (const p of precomp) {
          next.push(appendParent(p.chunk, p.hash));
        }
      } else {
        // serial
        for (let i = 0; i < current.length; i += 3) {
          const chunk = current.slice(i, Math.min(i + 3, current.length));
          const childHashes: Hash[] = [];
          for (const id of chunk) {
            childHashes.push(this.nodes[id].hash);
          }
          next.push(appendParent(chunk, combineHashes(childHashes)));
        }
      }

      current = next;
    }

    const root = current[0];
    this.rootID = root;

    if (this.cfg.enableMetrics) {
      this.metrics.buildTimeMS = performance.now() - start;
      this.metrics.memoryUsageBytes = this.estimateMemoryUsage();
    }
  }

  // ---------------------- Verify ----------------------

  async verify(leafIndex: number, data: Uint8Array): Promise<[boolean, Error | null]> {
    const start = performance.now();

    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      return [false, new TMTError(`${ErrorMessages.INVALID_INDEX}: ${leafIndex}`)];
    }
    if (this.rootID === null) {
      return [false, new TMTError(ErrorMessages.UNINITIALIZED)];
    }

    const exp = computeHash(data);
    if (!hashesEqual(this.nodes[leafIndex].hash, exp)) {
      if (this.cfg.enableMetrics) {
        this.metrics.lastVerificationTimeNS = (performance.now() - start) * 1_000_000;
        this.metrics.totalVerifications++;
      }
      return [false, null];
    }

    try {
      const proof = this.generateProofInternal(leafIndex);
      const ok = this.verifyProofInternal(proof, exp, this.rootID);

      if (this.cfg.enableMetrics) {
        this.metrics.lastVerificationTimeNS = (performance.now() - start) * 1_000_000;
        this.metrics.totalVerifications++;
      }
      return [ok, null];
    } catch (err) {
      return [false, err as Error];
    }
  }

  // ---------------------- Update & BatchUpdate ----------------------

  async update(leafIndex: number, newData: Uint8Array): Promise<void> {
    const start = performance.now();

    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      throw new TMTError(`${ErrorMessages.INVALID_INDEX}: ${leafIndex}`);
    }

    this.leafData[leafIndex] = new Uint8Array(newData);
    this.nodes[leafIndex].hash = computeHash(newData);

    this.updateAncestors(leafIndex);

    if (this.cfg.enableMetrics) {
      this.metrics.lastUpdateTimeNS = (performance.now() - start) * 1_000_000;
      this.metrics.totalUpdates++;
    }
  }

  async batchUpdate(updates: Map<number, Uint8Array>): Promise<void> {
    const start = performance.now();

    // validate indices
    const updateEntries = Array.from(updates.entries());
    for (const [idx] of updateEntries) {
      if (idx < 0 || idx >= this.leafCount) {
        throw new TMTError(`${ErrorMessages.INVALID_INDEX}: ${idx}`);
      }
    }

    // apply updates
    for (const [idx, data] of updateEntries) {
      this.leafData[idx] = new Uint8Array(data);
      this.nodes[idx].hash = computeHash(data);
    }

    // collect affected ancestors
    const affected = new Set<NodeID>();
    for (const [idx] of updateEntries) {
      this.collectAncestors(idx, affected);
    }

    // simple upward recompute until stable
    const queue: NodeID[] = Array.from(affected);
    const seen = new Set<NodeID>();
    
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) {
        continue;
      }
      this.recomputeNodeHash(id);
      seen.add(id);
      const parent = this.nodes[id].parent;
      if (parent !== null) {
        queue.push(parent);
      }
    }

    if (this.cfg.enableMetrics) {
      this.metrics.lastUpdateTimeNS = (performance.now() - start) * 1_000_000;
      this.metrics.totalUpdates += updates.size;
    }
  }

  // ---------------------- Proofs ----------------------

  generateProof(leafIndex: number): VerificationProof {
    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      throw new TMTError(`${ErrorMessages.INVALID_INDEX}: ${leafIndex}`);
    }
    return this.generateProofInternal(leafIndex);
  }

  verifyProof(proof: VerificationProof, leafData: Uint8Array): [boolean, Error | null] {
    if (this.rootID === null) {
      return [false, new TMTError(ErrorMessages.UNINITIALIZED)];
    }
    const leafHash = computeHash(leafData);
    return [this.verifyProofInternal(proof, leafHash, this.rootID), null];
  }

  private generateProofInternal(leafIndex: number): VerificationProof {
    const sibs: SiblingHash[] = [];
    let cur = leafIndex;
    let path = 0;

    while (true) {
      const n = this.nodes[cur];
      if (n.parent === null) {
        break;
      }
      const pid = n.parent;
      const parent = this.nodes[pid];

      let pos = -1;
      for (let i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === cur) {
          pos = i;
          break;
        }
      }
      if (pos < 0) {
        throw new TMTError(ErrorMessages.MISSING_PARENT);
      }

      for (let i = 0; i < parent.children.length; i++) {
        if (i === pos) {
          continue;
        }
        const cid = parent.children[i];
        sibs.push({ pos: i, hash: this.nodes[cid].hash });
      }

      cur = pid;
      path++;
    }

    return {
      leafIndex,
      siblingHashes: sibs,
      pathLength: path,
    };
  }

  private verifyProofInternal(proof: VerificationProof, leafHash: Hash, root: NodeID): boolean {
    let curID = proof.leafIndex;
    let curHash = leafHash;
    let si = 0;

    for (let step = 0; step < proof.pathLength; step++) {
      const n = this.nodes[curID];
      if (n.parent === null) {
        return false;
      }
      const pid = n.parent;
      const parent = this.nodes[pid];

      let pos = -1;
      for (let i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === curID) {
          pos = i;
          break;
        }
      }
      if (pos < 0) {
        return false;
      }

      const childHashes: Hash[] = new Array(parent.children.length);
      childHashes[pos] = curHash;

      const need = parent.children.length - 1;
      for (let i = 0; i < need; i++) {
        if (si >= proof.siblingHashes.length) {
          return false;
        }
        const sh = proof.siblingHashes[si];
        si++;
        if (sh.pos === pos || sh.pos < 0 || sh.pos >= childHashes.length) {
          return false;
        }
        childHashes[sh.pos] = sh.hash;
      }

      curHash = combineHashes(childHashes);
      curID = pid;
    }

    return si === proof.siblingHashes.length && hashesEqual(curHash, this.nodes[root].hash);
  }

  // ---------------------- Serialization ----------------------

  serialize(): string {
    const snodes: SerializableNode[] = [];
    for (let id = 0; id < this.nodes.length; id++) {
      const n = this.nodes[id];
      snodes.push({
        id,
        hash: Array.from(n.hash),
        children: [...n.children],
        isLeaf: n.isLeaf,
        parent: n.parent,
      });
    }

    const cpLeaves: number[][] = [];
    for (const leaf of this.leafData) {
      cpLeaves.push(Array.from(leaf));
    }

    const blob: SerializedBlob = {
      nodes: snodes,
      leafData: cpLeaves,
      rootID: this.rootID,
      leafCount: this.leafCount,
    };

    try {
      return JSON.stringify(blob);
    } catch (err) {
      throw new TMTError(`${ErrorMessages.SERIALIZATION}: ${err}`);
    }
  }

  static deserialize(data: string, cfg: Config = defaultConfig()): TernaryMeshTree {
    let blob: SerializedBlob;
    try {
      blob = JSON.parse(data);
    } catch (err) {
      throw new TMTError(`${ErrorMessages.SERIALIZATION}: ${err}`);
    }

    const nodes: InternalNode[] = [];
    for (const n of blob.nodes) {
      nodes.push({
        hash: new Uint8Array(n.hash),
        children: [...n.children],
        isLeaf: n.isLeaf,
        parent: n.parent,
      });
    }

    const leafData: Uint8Array[] = [];
    for (const leaf of blob.leafData) {
      leafData.push(new Uint8Array(leaf));
    }

    const tree = new TernaryMeshTree(cfg);
    (tree as any).nodes = nodes;
    (tree as any).leafData = leafData;
    (tree as any).rootID = blob.rootID;
    (tree as any).leafCount = blob.leafCount;

    return tree;
  }

  // ---------------------- Getters ----------------------

  getMetrics(): Metrics {
    if (!this.cfg.enableMetrics) {
      return {
        buildTimeMS: 0,
        lastVerificationTimeNS: 0,
        lastUpdateTimeNS: 0,
        totalVerifications: 0,
        totalUpdates: 0,
        memoryUsageBytes: 0,
      };
    }
    return { ...this.metrics };
  }

  getRootHash(): [Hash | null, boolean] {
    if (this.rootID === null) {
      return [null, false];
    }
    return [this.nodes[this.rootID].hash, true];
  }

  getHeight(): number {
    if (this.rootID === null) {
      return 0;
    }
    return this.calculateHeight(this.rootID);
  }

  getLeafCount(): number {
    return this.leafCount;
  }

  // ---------------------- internals ----------------------

  private async getCachedHash(data: Uint8Array): Promise<Hash> {
    if (!this.cfg.enableCaching) {
      return computeHash(data);
    }

    const key = Array.from(data).join(',');
    if (this.hashCache.has(key)) {
      return this.hashCache.get(key)!;
    }

    const h = computeHash(data);
    if (this.hashCache.size < this.cfg.maxCacheSize) {
      this.hashCache.set(key, h);
    }
    return h;
  }

  private updateAncestors(cur: NodeID): void {
    const anc: NodeID[] = [];
    let current = cur;
    
    while (true) {
      const n = this.nodes[current];
      if (n.parent === null) {
        break;
      }
      const p = n.parent;
      anc.push(p);
      current = p;
    }

    for (let i = anc.length - 1; i >= 0; i--) {
      this.recomputeNodeHash(anc[i]);
    }
  }

  private collectAncestors(cur: NodeID, set: Set<NodeID>): void {
    let current = cur;
    while (true) {
      const n = this.nodes[current];
      if (n.parent === null) {
        break;
      }
      const p = n.parent;
      set.add(p);
      current = p;
    }
  }

  private recomputeNodeHash(id: NodeID): void {
    if (id >= this.nodes.length) {
      throw new TMTError(`${ErrorMessages.INVALID_INDEX}: ${id}`);
    }
    const n = this.nodes[id];
    if (n.isLeaf) {
      return;
    }
    const childHashes: Hash[] = [];
    for (const cid of n.children) {
      childHashes.push(this.nodes[cid].hash);
    }
    this.nodes[id].hash = combineHashes(childHashes);
  }

  private calculateHeight(id: NodeID): number {
    const n = this.nodes[id];
    if (n.isLeaf) {
      return 1;
    }
    let maxH = 0;
    for (const cid of n.children) {
      const h = this.calculateHeight(cid);
      if (h > maxH) {
        maxH = h;
      }
    }
    return maxH + 1;
  }

  private estimateMemoryUsage(): number {
    // quick estimate: node header + leaves
    const approxNodeBytes = 80; // rough avg estimate
    let total = approxNodeBytes * this.nodes.length;
    for (const d of this.leafData) {
      total += d.length;
    }
    return total;
  }
}

// ---------------------- helpers ----------------------



function chunkBy<T>(arr: T[], k: number): T[][] {
  if (k <= 0) {
    return [arr];
  }
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += k) {
    const j = Math.min(i + k, arr.length);
    out.push(arr.slice(i, j));
  }
  return out;
}

// ---------------------- Self-test (optional) ----------------------

// selfTest runs a minimal sequence similar to the original tests.
export async function selfTest(): Promise<void> {
  const t = new TernaryMeshTree();
  const data = [
    new TextEncoder().encode('block1'),
    new TextEncoder().encode('block2'),
    new TextEncoder().encode('block3'),
  ];
  
  await t.build(data);
  
  const [ok1, err1] = await t.verify(0, new TextEncoder().encode('block1'));
  if (err1 || !ok1) {
    throw new TMTError(`verify before update failed: ${err1?.message}`);
  }
  
  await t.update(0, new TextEncoder().encode('new_block1'));
  
  const [ok2, err2] = await t.verify(0, new TextEncoder().encode('new_block1'));
  if (err2 || !ok2) {
    throw new TMTError(`verify after update failed: ${err2?.message}`);
  }
  
  const blob = t.serialize();
  const t2 = TernaryMeshTree.deserialize(blob, defaultConfig());
  
  const [r1] = t.getRootHash();
  const [r2] = t2.getRootHash();
  
  if (!r1 || !r2 || !hashesEqual(r1, r2)) {
    throw new TMTError('root hash mismatch after deserialize');
  }
}

// ---------------------- Default export ----------------------

export default TernaryMeshTree;