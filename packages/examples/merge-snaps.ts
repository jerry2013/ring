import { spawn } from 'child_process'
import { FfmpegProcess } from '@homebridge/camera-utils'
import { Dirent } from 'fs'
import { open, opendir, unlink } from 'fs/promises'
import { join, parse } from 'node:path'

const FRAMERATE = 2

function* chunks<T>(arr: T[], n: number): Generator<T[], void> {
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n)
  }
}

async function* webVTT(folder: string, prefix: string) {
  let lastEntry: Dirent | null = null,
    timer = 0

  function timestamp() {
    return new Date(timer * 1e3).toISOString().split('T')[1].slice(0, -1)
  }

  function line() {
    const start = timestamp()
    timer += 1 / FRAMERATE
    return [
      '',
      `${start} --> ${timestamp()}`,
      `${parse(lastEntry!.name).name.split('-')[1].slice(0, -3)}`,
      '',
    ].join('\n')
  }

  for await (const entry of await opendir(folder)) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      if (lastEntry) {
        yield line()
      } else {
        yield 'WEBVTT\n'
      }
      lastEntry = entry
    }
  }

  if (lastEntry) {
    yield line()
  }
}

async function createWebVTT(folder: string, prefix: string, subfile: string) {
  const vtt = await open(subfile, 'w')
  for await (const line of webVTT(folder, prefix)) {
    await vtt.write(line)
  }
  await vtt.close()
}

export async function merge(
  outputDir: string,
  cameraId: number,
  date: string,
  hour: string
) {
  const folder = join(outputDir, String(cameraId), date),
    prefix = `snap-${hour}`,
    snaps = `${prefix}*.jpg`,
    outfile = join(folder, `timelapse-${hour}.mp4`),
    subfile = join(folder, `timelapse-${hour}.vtt`)

  await createWebVTT(folder, prefix, subfile)

  console.log(`Merging ${snaps} in ${folder}.`)
  const result = await new Promise<number | null>((resolve) => {
    new FfmpegProcess({
      ffmpegArgs: [
        '-nostats',
        ['-loglevel', 'error'],
        ['-framerate', FRAMERATE],
        ['-pattern_type', 'glob'],
        ['-i', join(folder, snaps)],
        ['-i', subfile],
        // ['-c', 'copy'],
        ['-c:s', 'mov_text'],
        ['-metadata:s:s:0', 'language=eng'],
        ['-disposition:s:0', 'default'],
        outfile,
      ].flatMap((v) => v),
      exitCallback: (code) => resolve(code),
      logLabel: `Timelapse (${cameraId}/${date} ${hour})`,
      logger: {
        error: console.error,
        info: console.log,
      },
    })
  })

  await unlink(subfile).catch(Object)

  if (result === 0) {
    // find . -name snaps -delete
    spawn('find', [folder, '-name', snaps, '-delete'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } else {
    await unlink(outfile).catch(Object)
  }
}

export async function mergeSnaps(
  outputDir: string,
  cameraId: number,
  date: string
) {
  for (const hours of chunks(
    new Array(24).fill(0).map((_, i) => i),
    2 // concurrent ffmpeg processes
  )) {
    await Promise.all(
      hours.map((hour) =>
        merge(outputDir, cameraId, date, String(hour).padStart(2, '0')).catch(
          Object
        )
      )
    )
  }
}
