import { serverFetcher } from "./sever-fetcher";
import { BehaviorSubject, Subject } from "rxjs";
import logger, { ModuleLogger } from "../logger";
import { ServerStatus } from "../api-helper";
import { writeFile } from "fs/promises";
import { join } from "path";
import { mkdirSync } from "fs";

const STATS_DIR = "data/stats";

try {
  mkdirSync(STATS_DIR, { recursive: true });
} catch (e) {
  logger.error("Error creating stats directory: " + e);
}

export class Fetcher<T> {
  protected logger: ModuleLogger;
  protected data: BehaviorSubject<T | null> = new BehaviorSubject<T | null>(null);
  public data$ = this.data.asObservable();
  private timeoutHandle: NodeJS.Timeout | null = null;
  private refreshInterval: number;

  protected avgRefreshTime = 0;
  protected refreshCount = 0;
  protected statFile: string;

  constructor(module: string, defaultRefreshInterval: number) {
    this.logger = new ModuleLogger(module);
    this.refreshInterval =
      (process.env[`${module}_REFRESH_INTERVAL`] &&
        parseInt(process.env[`${module}_REFRESH_INTERVAL`]!) * 1000) ||
      defaultRefreshInterval;
    this.logger.info(`Refresh interval: ${this.refreshInterval}`);
    this.statFile = join("data", "stats", `${module.toLocaleLowerCase()}.csv`);
  }

  public start() {
    this.refreshData();
  }

  private async refreshData() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }

    this.timeoutHandle = null;
    let time = 0;

    try {
      const start = Date.now();

      this.logger.info("Refreshing data...");
      this.data.next(await this.fetchData());

      time = Date.now() - start;

      if (this.avgRefreshTime === 0) {
        this.avgRefreshTime = time;
      } else {
        this.avgRefreshTime = (this.avgRefreshTime + time) / 2;
      }

      this.refreshCount++;

      this.logger.success(`Data refreshed in ${time}ms (avg: ${this.avgRefreshTime}ms)`);

      this.writeStats(time);
    } catch (e) {
      this.logger.error("Error refreshing data: " + e);
    }

    this.timeoutHandle = setTimeout(
      () => this.refreshData(),
      Math.max(0, this.refreshInterval - time)
    );
  }

  protected writeStats(time: number) {
    writeFile(this.statFile, `${new Date().toISOString()},${time},${this.refreshCount}\n`, {
      flag: "a",
    });
  }

  public get currentData(): T | null {
    return this.data.value;
  }

  protected async fetchData(): Promise<T> {
    throw new Error("Not implemented");
  }
}

export class PerServerFetcher<T> extends Fetcher<Map<string, T>> {
  private perServerData = new Subject<{ server: string; data: T }>();
  public perServerData$ = this.perServerData.asObservable();

  constructor(
    module: string,
    defaultRefreshInterval: number,
    private serverFetcher: Fetcher<ServerStatus[]>
  ) {
    super(module, defaultRefreshInterval);
  }

  protected writeStats(time: number) {
    writeFile(
      this.statFile,
      `${new Date().toISOString()};${time};${this.refreshCount};${
        this.serverFetcher.currentData?.length ?? 0
      }\n`,
      {
        flag: "a",
      }
    );
  }

  protected async fetchData() {
    const result = new Map<string, T>();

    for (const server of serverFetcher.currentData || []) {
      const data = await this.fetchDataForServer(server.ServerCode);
      result.set(server.ServerCode, data);
      this.perServerData.next({ server: server.ServerCode, data });
    }

    return result;
  }

  protected async fetchDataForServer(server: string): Promise<T> {
    throw new Error("Not implemented");
  }

  public getDataForServer(server: string): T | null {
    return this.currentData?.get(server) || null;
  }
}