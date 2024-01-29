const _log = console.log,
  _error = console.error,
  timestamp = Object.assign(
    {},
    {
      toString: function () {
        return new Date().toISOString()
      },
    }
  )
console.log = _log.bind(console, '%s', timestamp)
console.error = _error.bind(console, '%s', timestamp)

import 'dotenv/config'
import { spawn } from 'child_process'
import { FfmpegProcess } from '@homebridge/camera-utils'
import { PushNotificationAction, RingApi, RingCamera } from '../ring-client-api'
import { StreamingSession } from '../ring-client-api/lib/streaming/streaming-session'
import { timer } from 'rxjs'
import { skip } from 'rxjs/operators'
import { constants } from 'fs'
import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { join } from 'node:path'

const outputDir = process.env.OUTPUT_DIR || join(__dirname, 'output')

function* chunks<T>(arr: T[], n: number): Generator<T[], void> {
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n)
  }
}

const OverlayTextFilter = String.raw`drawtext="fontsize=10:fontcolor=yellow:fontfile=FreeSans.ttf:text='%{metadata\:lavf.image2dec.source_basename\:NA}':x=10:y=10"`

async function merge(cameraId: number, date: string, hour: string) {
  const folder = join(outputDir, String(cameraId), date),
    snaps = `snap-${hour}*.jpg`

  console.log(`Merging ${snaps} in ${folder}.`)
  await new Promise<number | null>((resolve) => {
    new FfmpegProcess({
      ffmpegArgs: [
        '-nostats',
        ['-loglevel', 'error'],
        ['-framerate', 2],
        ['-pattern_type', 'glob'],
        ['-export_path_metadata', 1],
        ['-i', join(folder, snaps)],
        ['-vf', OverlayTextFilter],
        join(folder, `timelapse-${hour}.mkv`),
      ].flatMap((v) => v),
      exitCallback: (code) => resolve(code),
      logLabel: `Timelapse (${cameraId}/${date} ${hour})`,
      logger: {
        error: console.error,
        info: console.log,
      },
    })
  }).then((result) => {
    if (result === 0) {
      // find . -name snaps -delete
      spawn('find', [folder, '-name', snaps, '-delete'], {
        detached: true,
        stdio: 'ignore',
      }).unref()
    }
  })
}

async function mergeSnaps(cameraId: number, date: string) {
  for (const hours of chunks(
    new Array(24).fill(0).map((_, i) => i),
    2 // concurrent ffmpeg processes
  )) {
    await Promise.all(
      hours.map((hour) => {
        return merge(cameraId, date, String(hour).padStart(2, '0'))
      })
    )
  }
}

async function outputFile(camera: RingCamera, type: string, ext: string) {
  const [date, time] = timestamp.toString().replace(/:/g, '.').split('T'),
    dir = join(outputDir, String(camera.id), date)
  await access(dir, constants.W_OK).catch(() => {
    const dt = new Date(date),
      yesterday = new Date(dt.setDate(dt.getDate() - 1)),
      yDate = yesterday.toISOString().split('T')[0]
    mergeSnaps(camera.id, yDate).catch(console.error)
    return mkdir(dir, { recursive: true })
  })
  return join(dir, `${type}-${time}.${ext}`)
}

async function example() {
  const { env } = process,
    ringApi = new RingApi({
      // Replace with your refresh token
      refreshToken: env.RING_REFRESH_TOKEN!,
      debug: false,
    }),
    locations = await ringApi.getLocations(),
    allCameras = await ringApi.getCameras()

  console.log(
    `Found ${locations.length} location(s) with ${allCameras.length} camera(s).`
  )

  ringApi.onRefreshTokenUpdated.subscribe(
    async ({ newRefreshToken, oldRefreshToken }) => {
      // If you are implementing a project that use `ring-client-api`, you should subscribe to onRefreshTokenUpdated and update your config each time it fires an event
      // Here is an example using a .env file for configuration
      if (!oldRefreshToken) {
        return
      }

      const currentConfig = await readFile('.env'),
        updatedConfig = currentConfig
          .toString()
          .replace(oldRefreshToken, newRefreshToken)

      await writeFile('.env', updatedConfig)
    }
  )

  for (const location of locations) {
    location.onConnected.pipe(skip(1)).subscribe((connected) => {
      const status = connected ? 'Connected to' : 'Disconnected from'
      console.log(`**** ${status} location ${location.name} - ${location.id}`)
    })
  }

  for (const location of locations) {
    const cameras = location.cameras,
      devices = await location.getDevices()

    console.log(
      `Location ${location.name} (${location.id}) has the following ${cameras.length} camera(s):`
    )

    for (const camera of cameras) {
      console.log(`- ${camera.id}: ${camera.name} (${camera.deviceType})`)
    }

    console.log(
      `Location ${location.name} (${location.id}) has the following ${devices.length} device(s):`
    )

    for (const device of devices) {
      console.log(`- ${device.zid}: ${device.name} (${device.deviceType})`)
    }
  }

  if (allCameras.length) {
    allCameras.forEach((camera) => {
      timer(0, 10e3).subscribe(async (count) => {
        console.log(`Writing snapshot from ${camera.name} ... ${count}`)
        const snap = await camera.getSnapshot().catch((error) => {
          console.log(`Snapshot from ${camera.name} failed... ${error}`)
          return null
        })
        if (snap) {
          await writeFile(await outputFile(camera, 'snap', 'jpg'), snap)
        }
      })

      let stopper: number, liveCall: StreamingSession | undefined
      const stopHandler: TimerHandler = () => {
        if (liveCall) {
          liveCall.stop()
          liveCall = undefined
          console.log('Done recording video')
        }
      }

      camera.onMotionDetected.subscribe(async (motion) => {
        console.log(`${motion ? 'Motion' : 'Ding'} from ${camera.name} ...`)

        clearTimeout(stopper)
        stopper = setTimeout(stopHandler, 120e3)

        if (!motion) {
          // extend the recording duration
          return
        }

        console.log(`Starting Video from ${camera.name} ...`)

        liveCall = await camera.startLiveCall()
        await liveCall.startTranscoding({
          output: [await outputFile(camera, 'motion', 'mp4')],
        })
      })

      camera.onNewNotification.subscribe(({ action, ding, subtype }) => {
        const event =
          action === PushNotificationAction.Motion
            ? 'Motion detected'
            : action === PushNotificationAction.Ding
            ? 'Doorbell pressed'
            : `Video started (${action})`

        console.log(
          `${event} on ${camera.name} camera (${subtype}). Ding id ${ding.id}.`
        )
      })
    })

    console.log('Listening for motion and doorbell presses on your cameras.')
  }
}

example().catch(console.error)
