import { readFileSync, renameSync, statSync } from "fs";
import type { Train } from "../api-helper";
import { parentPort } from "worker_threads";
import { ModuleLogger } from "../logger";
import { prisma } from "../db";
import { LRUCache } from "lru-cache";

const logger = new ModuleLogger("SIGNALS-PROC-WORKER");

const TrainPreviousSignals = new LRUCache<string, string>({
  ttl: 1000 * 60 * 60, // 1 hour
  ttlAutopurge: true,
  updateAgeOnGet: true,
});

async function loadFileLinesToDatabase(lines: string[]) {
  let newSignalCount = 0;
  let accuracyImprovementCount = 0;
  let typeSetCount = 0;

  logger.info(`Loading ${lines.length} signals from file to the database...`);

  const prevNextToBeAdded = new Map<string, { prev: string[]; next: string[] }>();

  const results = await Promise.allSettled(
    lines
      .filter((line) => line.trim().length > 0)
      .map(async (line) => {
        const [name, lat, lon, extra, _accuracy, type, prevSignalsStr, nextSignalsStr] =
          line.split(";");

        const accuracy = parseFloat(_accuracy);

        const signal = await prisma.signals.findUnique({ where: { name } });
        if (!signal) {
          newSignalCount++;
          await prisma.$executeRaw`
            INSERT INTO signals (name, point, extra, accuracy, type)
            VALUES (${name}, ${`SRID=4326;POINT(${lat} ${lon})`}, ${extra}, ${accuracy}, ${type})
            `;

          prevNextToBeAdded.set(name, {
            prev: prevSignalsStr.split(","),
            next: nextSignalsStr.split(","),
          });
        } else {
          if (signal.accuracy > accuracy) {
            accuracyImprovementCount++;
            await prisma.$executeRaw`
              UPDATE signals
              SET point = ${`SRID=4326;POINT(${lat} ${lon})`}, accuracy = ${accuracy}
              WHERE name = ${name}
            `;
          }

          if (!signal.type && type) {
            typeSetCount++;
            await prisma.$executeRaw`
              UPDATE signals
              SET type = ${type}
              WHERE name = ${name}
            `;
          }

          prevNextToBeAdded.set(name, {
            prev: prevSignalsStr.split(","),
            next: nextSignalsStr.split(","),
          });
        }
      })
  );

  for (const [name, { prev, next }] of prevNextToBeAdded) {
    if (prev.length > 0) {
      for (const prevSignal of prev) {
        try {
          await prisma.$executeRaw`
          INSERT INTO prev_signals (signal, prev_signal)
          VALUES (${name}, ${prevSignal})
        `;
        } catch (e) {
          logger.warn(`Failed to add prev signal ${prevSignal} to signal ${name}: ${e}`);
        }
      }
    }

    if (next.length > 0) {
      for (const nextSignal of next) {
        try {
          await prisma.$executeRaw`
          INSERT INTO next_signals (signal, next_signal)
          VALUES (${name}, ${nextSignal})
        `;
        } catch (e) {
          logger.error(`Failed to add next signal ${nextSignal} to signal ${name}: ${e}`);
        }
      }
    }
  }

  logger.info(
    `Loaded ${lines.length} signals from file to the database: ${newSignalCount} new signals, ${accuracyImprovementCount} accuracy improvements, ${typeSetCount} type sets`
  );

  if (results.some((result) => result.status === "rejected")) {
    logger.error("Some signals failed to load to the database");

    for (const result of results) {
      if (result.status === "rejected") {
        logger.debug(result.reason);
      }
    }
  }
}

try {
  statSync("data/signals.csv");
  logger.info("Loading signals...");
  loadFileLinesToDatabase(readFileSync("data/signals.csv", "utf-8").split("\n"));

  renameSync("data/signals.csv", `data/signals-${Date.now()}.csv`);

  logger.info(`Signals loaded from file to the database`);

  if (statSync("data/signals-old.csv")?.isFile()) {
    logger.info("Merging old signal data...");

    loadFileLinesToDatabase(readFileSync("data/signals-old.csv", "utf-8").split("\n"));

    renameSync("data/signals-old.csv", `data/signals-old-merged-${Date.now()}.csv`);
  }
} catch (e) {
  logger.warn(`No signals file found (${e})`);
}

const BLOCK_SIGNAL_REGEX = /^\w\d+_\d+\w?$/;
const BLOCK_SIGNAL_REVERSE_REGEX = /^\w\d+_\d+[A-Z]$/;

let running = false;

async function analyzeTrains(trains: Train[]) {
  if (running) {
    logger.warn("Already running, skipping...");
    return;
  }

  running = true;

  try {
    const start = Date.now();
    const signals = await prisma.signals.findMany({
      where: {
        name: {
          in: trains.map((train) => train?.TrainData?.SignalInFront?.split("@")[0]).filter(Boolean),
        },
      },
    });

    for (const train of trains) {
      if (!train.TrainData.Latititute || !train.TrainData.Longitute) {
        logger.warn(`Train ${train.TrainNoLocal} (${train.Type}) has no location data`);
        continue;
      }

      if (!train.TrainData.SignalInFront) {
        continue;
      }

      const trainId = train.id;
      const [signalId, extra] = train.TrainData.SignalInFront.split("@");
      const signal = signals.find((signal) => signal.name === signalId);

      const prevSignalId = TrainPreviousSignals.get(trainId);

      if (prevSignalId && prevSignalId !== signalId) {
        // train trainId was at prevSignalName and now is at signalId
        const prevSignal =
          signals.find((signal) => signal.name === prevSignalId) ||
          (await prisma.signals.findUnique({ where: { name: prevSignalId } }));

        if (prevSignal) {
          if (signal) {
            // add signalId to prevSignal's next signals
            try {
              await prisma.$executeRaw`
            INSERT INTO next_signals (signal, next_signal)
            VALUES (${prevSignalId}, ${signalId})
            ON CONFLICT DO NOTHING
          `;
            } catch {
              // ignore
            }
          }

          const prevSignalNextSignals = await prisma.$queryRaw<{ next_signal: string }[]>`
            SELECT next_signal FROM next_signals WHERE signal = ${prevSignalId}
          `;

          if (
            prevSignalNextSignals.length > 1 &&
            BLOCK_SIGNAL_REGEX.test(prevSignalId) &&
            BLOCK_SIGNAL_REGEX.test(signalId)
          ) {
            const possibleNextSignals = prevSignalNextSignals.filter((nextSignalId) =>
              BLOCK_SIGNAL_REVERSE_REGEX.test(prevSignalId)
                ? BLOCK_SIGNAL_REVERSE_REGEX.test(nextSignalId.next_signal)
                : !BLOCK_SIGNAL_REVERSE_REGEX.test(nextSignalId.next_signal)
            );

            const nextSignals = possibleNextSignals.length
              ? await prisma.$queryRawUnsafe<{ name: string; lat: number; lon: number }[]>(`
            SELECT name, ST_X(point) as lat, ST_Y(point) as lon
            FROM signals
            WHERE name IN (${possibleNextSignals
              .map((nextSignalId) => `'${nextSignalId.next_signal}'`)
              .join(",")})
          `)
              : [];

            const distances = possibleNextSignals
              .map((nextSignalId) => {
                const nextSignal = nextSignals.find(
                  (signal) => signal.name === nextSignalId.next_signal
                );

                if (!nextSignal) {
                  return { nextSignalId, distance: Infinity };
                }

                return {
                  nextSignalId,
                  distance: distance(
                    [nextSignal.lat, nextSignal.lon],
                    [train.TrainData.Latititute, train.TrainData.Longitute]
                  ),
                };
              })
              .toSorted((a, b) => a.distance - b.distance);

            if (distances.length) {
              logger.info(
                `Block Signal ${prevSignalId} has more than 1 next signal: ${prevSignalNextSignals
                  .map((x) => x.next_signal)
                  .join(", ")}; keeping the closest one (${distances[0].nextSignalId.next_signal})`
              );

              await prisma.$executeRaw`
              DELETE FROM next_signals
              WHERE signal = ${prevSignalId} AND next_signal != ${distances[0].nextSignalId.next_signal}
            `;
            }
          }
        }

        if (signal) {
          // add prevSignalName to signal's prev signals
          try {
            await prisma.$executeRaw`
            INSERT INTO prev_signals (signal, prev_signal)
            VALUES (${signalId}, ${prevSignalId})
            ON CONFLICT DO NOTHING
          `;
          } catch (e) {
            logger.warn(`Failed to add prev signal ${prevSignalId} to signal ${signalId}: ${e}`);
          }

          const signalPrevSignals = await prisma.$queryRaw<{ prev_signal: string }[]>`
            SELECT prev_signal FROM prev_signals WHERE signal = ${signalId}
          `;

          if (
            signalPrevSignals.length > 1 &&
            BLOCK_SIGNAL_REGEX.test(prevSignalId) &&
            BLOCK_SIGNAL_REGEX.test(signalId)
          ) {
            const possiblePrevSignals = signalPrevSignals.filter((prevSignalId) =>
              BLOCK_SIGNAL_REVERSE_REGEX.test(signalId)
                ? BLOCK_SIGNAL_REVERSE_REGEX.test(prevSignalId.prev_signal)
                : !BLOCK_SIGNAL_REVERSE_REGEX.test(prevSignalId.prev_signal)
            );

            const prevSignals = possiblePrevSignals.length
              ? await prisma.$queryRawUnsafe<{ name: string; lat: number; lon: number }[]>(`
            SELECT name, ST_X(point) as lat, ST_Y(point) as lon
            FROM signals
            WHERE name IN (${possiblePrevSignals
              .map((prevSignalId) => `'${prevSignalId.prev_signal}'`)
              .join(",")})
          `)
              : [];

            const distances = signalPrevSignals
              .filter((prevSignalId) =>
                BLOCK_SIGNAL_REVERSE_REGEX.test(signalId)
                  ? BLOCK_SIGNAL_REVERSE_REGEX.test(prevSignalId.prev_signal)
                  : !BLOCK_SIGNAL_REVERSE_REGEX.test(prevSignalId.prev_signal)
              )
              .map((prevSignalId) => {
                const prevSignal = prevSignals.find(
                  (signal) => signal.name === prevSignalId.prev_signal
                );

                if (!prevSignal) {
                  return { prevSignalId, distance: Infinity };
                }

                return {
                  prevSignalId,
                  distance: distance(
                    [prevSignal.lat, prevSignal.lon],
                    [train.TrainData.Latititute, train.TrainData.Longitute]
                  ),
                };
              })
              .toSorted((a, b) => a.distance - b.distance);

            if (distances.length) {
              logger.info(
                `Block Signal ${signalId} has more than 1 prev signal: ${signalPrevSignals
                  .map((x) => x.prev_signal)
                  .join(", ")}; keeping the closest one (${distances[0].prevSignalId.prev_signal})`
              );

              await prisma.$executeRaw`
              DELETE FROM prev_signals
              WHERE signal = ${signalId} AND prev_signal != ${distances[0].prevSignalId.prev_signal}
            `;
            }
          }
        }
      }

      TrainPreviousSignals.set(trainId, signalId);

      if (train.TrainData.DistanceToSignalInFront < 5) {
        const signal = await prisma.signals.findUnique({ where: { name: signalId } });
        if (signal) {
          if (signal.accuracy > train.TrainData.DistanceToSignalInFront) {
            await prisma.$executeRaw`
            UPDATE signals
            SET accuracy = ${
              train.TrainData.DistanceToSignalInFront
            }, point = ${`SRID=4326;POINT(${train.TrainData.Latititute} ${train.TrainData.Longitute})`}
            WHERE name = ${signalId}
          `;
            logger.success(
              `Signal ${signalId} accuracy updated from ${signal.accuracy}m to ${
                train.TrainData.DistanceToSignalInFront
              }m (${signal.accuracy - train.TrainData.DistanceToSignalInFront}m)`
            );
          }

          if (
            !signal.type &&
            (train.TrainData.SignalInFrontSpeed === 60 ||
              train.TrainData.SignalInFrontSpeed === 100 ||
              BLOCK_SIGNAL_REGEX.test(signalId))
          ) {
            await prisma.$executeRaw`
            UPDATE signals
            SET type = ${getSignalType(train)}
            WHERE name = ${signalId}
          `;
            logger.success(
              `Signal ${signalId} type set to ${
                BLOCK_SIGNAL_REGEX.test(signalId) ? "block" : "main"
              } because of speed ${train.TrainData.SignalInFrontSpeed}km/h`
            );
          }
        } else {
          logger.success(
            `New signal detected: ${signalId} at ${train.TrainData.Latititute}, ${train.TrainData.Longitute} (${extra}) with accuracy ${train.TrainData.DistanceToSignalInFront}m`
          );
        }
      }
    }

    logger.info(`${trains.length} trains analyzed in ${Date.now() - start}ms`);
  } catch (e) {
    logger.error(`Error analyzing trains: ${e}`);
  } finally {
    running = false;
  }
}

function getSignalType(train: Train) {
  if (train.TrainData.SignalInFrontSpeed === 60 || train.TrainData.SignalInFrontSpeed === 100) {
    return "main";
  }

  if (BLOCK_SIGNAL_REGEX.test(train.TrainData.SignalInFront)) {
    return "block";
  }

  return null;
}

function distance(point1: [number, number], point2: [number, number]) {
  return Math.sqrt((point1[0] - point2[0]) ** 2 + (point1[1] - point2[1]) ** 2);
}

parentPort?.on("message", async (msg) => {
  switch (msg.type) {
    case "analyze":
      analyzeTrains(msg.data);
      break;
    default:
      logger.warn(`Unknown message type: ${msg.type}`);
      break;
  }
});
