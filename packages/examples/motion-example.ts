const _log = console.log,
  timestamp = function () {
    return
  }
timestamp.toString = function () {
  return new Date().toISOString()
}
console.log = _log.bind(console, '%s', timestamp)

import 'dotenv/config'
import { PushNotificationAction, RingApi, RingCamera } from '../ring-client-api'
import { timer } from 'rxjs'
import { skip } from 'rxjs/operators'
import { constants } from 'fs'
import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { join } from 'node:path'

const outputDir = process.env.OUTPUT_DIR || join(__dirname, 'output')

async function outputFile(camera: RingCamera, type: string, ext: string) {
  const [date, time] = timestamp.toString().replace(/:/g, '.').split('T'),
    dir = join(outputDir, String(camera.id), date)
  await access(dir, constants.W_OK).catch(() => mkdir(dir, { recursive: true }))
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
    `Found ${locations.length} location(s) with ${allCameras.length} camera(s).`,
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
    },
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
      `Location ${location.name} (${location.id}) has the following ${cameras.length} camera(s):`,
    )

    for (const camera of cameras) {
      console.log(`- ${camera.id}: ${camera.name} (${camera.deviceType})`)
    }

    console.log(
      `Location ${location.name} (${location.id}) has the following ${devices.length} device(s):`,
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

      camera.onMotionDetected.subscribe(async (motion) => {
        console.log(`${motion ? 'Motion' : 'Ding'} from ${camera.name} ...`)
        if (!motion) {
          return
        }

        console.log(`Starting Video from ${camera.name} ...`)
        await camera.recordToFile(
          await outputFile(camera, 'motion', 'mp4'),
          120
        )
        console.log('Done recording video')
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
