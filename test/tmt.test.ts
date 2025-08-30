import { TextEncoder } from 'util';
import TernaryMeshTree from '../src';

describe('TernaryMeshTree', () => {
  it('should build a tree correctly', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    expect(tree.getLeafCount()).toBe(3);
    const [rootHash] = tree.getRootHash();
    expect(rootHash).not.toBeNull();
  });

  it('should verify a leaf correctly', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    const [ok, err] = await tree.verify(0, new TextEncoder().encode('block1'));
    expect(ok).toBe(true);
    expect(err).toBeNull();
  });

  it('should fail to verify incorrect data', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    const [ok, err] = await tree.verify(0, new TextEncoder().encode('wrong data'));
    expect(ok).toBe(false);
    expect(err).toBeNull();
  });

  it('should update a leaf and verify the new data', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    await tree.update(0, new TextEncoder().encode('new_block1'));
    const [ok, err] = await tree.verify(0, new TextEncoder().encode('new_block1'));
    expect(ok).toBe(true);
    expect(err).toBeNull();
  });

  it('should serialize and deserialize the tree', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    const serialized = tree.serialize();
    const newTree = TernaryMeshTree.deserialize(serialized);

    const [rootHash1] = tree.getRootHash();
    const [rootHash2] = newTree.getRootHash();
    expect(rootHash1).toEqual(rootHash2);
  });

  it('should generate and verify a proof', async () => {
    const tree = new TernaryMeshTree();
    const data = [
      new TextEncoder().encode('block1'),
      new TextEncoder().encode('block2'),
      new TextEncoder().encode('block3'),
    ];
    await tree.build(data);
    const proof = tree.generateProof(0);
    const [ok, err] = tree.verifyProof(proof, new TextEncoder().encode('block1'));
    expect(ok).toBe(true);
    expect(err).toBeNull();
  });
});