import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'

/**
 * Play/pause/skip, aimed at whatever app currently holds the system media
 * session — Spotify's desktop app if that's what's playing, same as a
 * physical media key on a keyboard would hit. No Spotify account, API key
 * or OAuth needed, and deliberately no search-and-play: that needs the
 * real Spotify Web API, which is a bigger, separate thing to wire up.
 *
 * Implemented by asking Windows to press the actual virtual key
 * (user32.keybd_event via a one-line PowerShell + Add-Type), not by
 * talking to Spotify at all — which is also why this works for whatever
 * else might be playing (a browser tab, Windows Media Player), not only
 * Spotify.
 */

const VK = { play_pause: 0xb3, next: 0xb0, previous: 0xb1 }

function pressMediaKey(vk) {
  const script =
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
    'public class JarvisKeys{[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}\';' +
    `[JarvisKeys]::keybd_event(${vk},0,0,[UIntPtr]::Zero);` +
    `[JarvisKeys]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000 },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}

const CONTROL_DESCRIPTION = `Play/pause, skip to next, or go back to the
previous track — sent as an actual media-key press, so it controls
whatever app currently owns the system media session (usually Spotify,
if that's what's playing). Can't search for or start a specific song.`

export function musicServer() {
  return createSdkMcpServer({
    name: 'jarvis_music',
    version: '1.0.0',
    instructions: 'Media-key playback control only (play/pause/next/previous) — no search, no specific track.',
    alwaysLoad: true,
    tools: [
      tool(
        'music_control',
        CONTROL_DESCRIPTION,
        {
          action: z.enum(['play_pause', 'next', 'previous']).describe('Which media key to press.'),
        },
        async (args) => {
          try {
            await pressMediaKey(VK[args.action])
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Media key failed: ${err?.message ?? err}` }] }
          }
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      ),
    ],
  })
}
