import { SQSClientConfiguration, SQSClientContext, GbConsumerOptions } from './types/index';
import { EventEmitter } from 'events';
import { STSClient, GetCallerIdentityCommand, GetCallerIdentityCommandInput, GetCallerIdentityCommandOutput } from '@aws-sdk/client-sts';
import { SQSClient } from '@aws-sdk/client-sqs';
import _ from 'lodash';
import SqsQueue from './queue';
import { normalizeQueueConfig } from './util';
import { assumeRole } from './roles';

const DEFAULT_ENDPOINT = Symbol('Default SQS endpoint');
const ENDPOINT_CONFIG = Symbol('SQS Endpoint Config');

function buildQueue(queueClient: any, logicalName: string, queueConfig: any): SqsQueue {
  const { name = logicalName, endpoint, deadLetter } = queueConfig;
  const client = queueClient.sqsClients[endpoint || DEFAULT_ENDPOINT];
  const { accountId } = client[ENDPOINT_CONFIG];

  let queueUrl = name;
  if (!/^https?:/.test(name)) {
    queueUrl = `${_.trimEnd(client[ENDPOINT_CONFIG].endpoint, '/')}${accountId ? '/' : ''}${accountId || ''}/${name}`;
  }

  return new SqsQueue(queueClient, client, { ...queueConfig, queueUrl, logicalName, deadLetter });
}

export default class ConfiguredSQSClient extends EventEmitter {
  config: any;
  logger: any;
  defaultSubscriptionOptions: any;
  assumedRole: any;

  sqsClients: any = {}

  queues: any = {}

  endpoints: any = [];

  constructor(context: any, config: any) {
    super();

    this.config = config;
    this.logger = context.logger;
    const { queues, endpoint, endpoints, accountId, region, subscriptions, assumedRole } = config;

    this.defaultSubscriptionOptions = {
      waitTimeSeconds: 5,
      ...subscriptions,
    };

    if (endpoint || region) {
      let defaultEp = endpoint;
      if (typeof endpoint === 'string') {
        defaultEp = { endpoint, region };
      }
      this.logger.info('Creating default SQS endpoint', {
        endpoint: defaultEp?.endpoint || 'unspecified',
        region,
      });
      this.sqsClients[DEFAULT_ENDPOINT] = new SQSClient({
        region,
        ...defaultEp,
      });
      this.sqsClients[DEFAULT_ENDPOINT][ENDPOINT_CONFIG] = {
        endpoint: defaultEp?.endpoint || this.sqsClients[DEFAULT_ENDPOINT].endpoint?.href,
        accountId,
      };
    }

    if (endpoints) {
      this.buildEndpoints(context, endpoints);
    }

    if (assumedRole) {
      this.assumedRole = assumedRole;
    }

    normalizeQueueConfig(queues).forEach((queueConfig) => {
      const { logicalName, name } = queueConfig;
      const localName = logicalName || name;
      this.queues[localName] = buildQueue(this, localName, queueConfig);
      context.logger.info('Added queue', {
        logicalName: localName,
        url: this.queues[localName].config.queueUrl,
      });
    });
  }

  getSQSClient(endpoint: any = DEFAULT_ENDPOINT): SQSClient {
    return this.sqsClients[endpoint];
  }

  async buildEndpoints(context: any, config: any) {
    Object.entries(this.endpoints).forEach(([logicalName, { accountId: epAccountId, endpoint: epEndpoint, ...epConfig }]: any) => {
      this.logger.info('Creating SQS endpoint', {
        logicalName,
        endpoint: epEndpoint,
      });
      this.sqsClients[logicalName] = new SQSClient({
        endpoint: epEndpoint,
        ...epConfig,
      });
      this.sqsClients[logicalName][ENDPOINT_CONFIG] = {
        accountId: epAccountId,
        endpoint: epEndpoint,
      };
    });
  }

  getQueues(context: any, config: any) {
    return this.queues;
  }

  getQueue(context: any, logicalQueue: string) {
    const sqsQueue = this.queues[logicalQueue];
    if (!sqsQueue) {
      const e = new Error(`Unable to find a logical queue named '${logicalQueue}'`);
      // e.code = 'InvalidQueue';
      // e.domain = 'SqsClient';
      throw e;
    }
    return sqsQueue;
  }

  async createSQSClient(context: SQSClientContext, config: SQSClientConfiguration) {
    this.endpoints = await this.buildEndpoints(context, config.endpoints);
    this.queues = await this.getQueues(context, config.queues);
  }

  async recieveMessage(context: any, queueName: string): Promise<any> {
    return {};
  }

  async subscribe(context: any, logicalQueue: string, handler: Function, options: GbConsumerOptions) {
    console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% SUBSCRIBING');
    if (process.env.DISABLE_SQS_SUBSCRIPTIONS === 'true') {
      return Promise.resolve(false);
    }
    if (process.env.DISABLE_SQS_SUBSCRIPTIONS) {
      const disabled = process.env.DISABLE_SQS_SUBSCRIPTIONS.split(',');
      if (disabled.includes(logicalQueue)) {
        return Promise.resolve(false);
      }
    }

    const sqsQueue = <SqsQueue>this.getQueue(context, logicalQueue);
    return sqsQueue.subscribe(context, handler, {
      ...this.defaultSubscriptionOptions,
      ...options,
    });
  }

  async start(context: any) {
    await assumeRole(this.assumedRole);
    await Promise.all(Object.entries(this.queues).map(([, q]: any[]) => q.start(context)));
    return this;
  }
}