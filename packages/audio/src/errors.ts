/**
 * Error taxonomy for the audio subsystem.
 *
 * These are deliberately distinct classes rather than bare `Error`s, because the caller
 * needs to react differently to each:
 *
 * - `UnsupportedAudioFormatError` — the bytes or the request are outside what this
 *   module can represent honestly. Retrying will not help; the caller must change the
 *   input (different bit depth, different channel count).
 * - `VoiceDirectionError` — the direction is internally contradictory, e.g. two
 *   mutually exclusive emphases. A programming error worth failing loudly on.
 * - `AudioMixError` — the mix cannot be produced as described, e.g. a clip that starts
 *   past the end of the timeline. Never silently truncated.
 *
 * All three extend `Error` so existing `catch` sites keep working.
 */

export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedAudioFormatError extends AudioError {}

export class VoiceDirectionError extends AudioError {}

export class AudioMixError extends AudioError {}