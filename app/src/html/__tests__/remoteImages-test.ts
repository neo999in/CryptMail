/**
 * The count behind the "images not loaded" strip.
 *
 * The number is the whole reason the strip is honest rather than vague, so the
 * cases that matter are the ones where a naive count would be wrong: the same
 * pixel twice, an image that carries its own bytes, and markup that merely
 * mentions the word.
 */
import { countRemoteImages, remoteImageSources } from '../remoteImages';

describe('counting what a message would fetch', () => {
  it('counts a remote image', () => {
    expect(countRemoteImages('<p>hi</p><img src="https://tracker.example/px.gif">')).toBe(1);
  });

  it('reads a src however it is quoted', () => {
    const html = `<img src="https://a.example/1.png"><img src='https://b.example/2.png'><img src=https://c.example/3.png>`;

    expect(countRemoteImages(html)).toBe(3);
  });

  it('counts protocol-relative sources, which resolve to http(s)', () => {
    expect(countRemoteImages('<img src="//tracker.example/px.gif">')).toBe(1);
  });

  /**
   * One host learns the message was opened once, however many times its spacer
   * appears. Counting tags would report a newsletter's layout, not its cost.
   */
  it('counts one disclosure per distinct source', () => {
    const html = '<img src="https://a.example/px.gif"><hr><img src="https://a.example/px.gif">';

    expect(countRemoteImages(html)).toBe(1);
    expect(remoteImageSources(html)).toEqual(new Set(['https://a.example/px.gif']));
  });

  it('ignores an image that carries its own bytes', () => {
    expect(countRemoteImages('<img src="data:image/gif;base64,R0lGOD">')).toBe(0);
  });

  it('ignores the message’s own attached parts', () => {
    expect(countRemoteImages('<img src="cid:logo@example">')).toBe(0);
  });

  it('is not fooled by the word appearing in text', () => {
    expect(countRemoteImages('<p>Attach an img src= to the report.</p>')).toBe(0);
  });

  it('says nothing to count on a message with no images', () => {
    expect(countRemoteImages('<p>Just words.</p>')).toBe(0);
    expect(countRemoteImages('')).toBe(0);
  });

  /** The scan is stateless: the shared regex must not carry a cursor between calls. */
  it('gives the same answer twice', () => {
    const html = '<img src="https://a.example/1.png"><img src="https://b.example/2.png">';

    expect(countRemoteImages(html)).toBe(2);
    expect(countRemoteImages(html)).toBe(2);
  });
});
