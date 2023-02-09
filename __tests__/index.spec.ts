import { v4 as uuid } from 'uuid';
import SqsClient from '../src/index';
import { SQSClientConfiguration, SQSClientContext, BaseLogger } from '../src/types/index';

const ctx: SQSClientContext = {
  logger: <BaseLogger>{ level: 'info', error: console.log, warn: console.warn, info: console.log },
  headers: { correlationid: uuid() },
  service: {
    wrapError(e: any, args = {}) { return Object.assign(e, args); },
  },
};

const sqsHost = process.env.SQS_HOST || 'localhost';
const sqsPort = process.env.SQS_PORT || 9324;
const accountId = process.env.SQS_ACCOUNT_ID || 1;

const qConfig = {
  region: 'us-east-1',
  endpoint: {
    // ElasticMQ wants "queue" there rather than an account id
    endpoint: `http://${sqsHost}:${sqsPort}/${accountId}`,
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  },
  queues: {
    testQueue: {
      name: 'gas_price_refresh', // 'test-queue',
    },
    /*
    basic: 'basic_queue',
    unreal: 'this_queue_does_not_exist',
    quick: 'quick_queue',
    redrive: { name: 'redrive_queue', deadLetter: 'dead', readers: 10 },
    dead: 'dead_letter_queue',
    autoDead: { deadLetter: 'this_should_get_made' },
    */
  },
  subscriptions: {
    waitTimeSeconds: 1,
  },
  // assumedRole: 'user',
  contextFunction(context: any, message: any) {
    return {
      ...context,
      headers: { correlationid: message?.MessageAttributes?.CorrelationId?.StringValue },
    };
  },
};

test('Test subscription', async () => {
  const sqs = new SqsClient(ctx, qConfig);
  console.log(`sqs keys = ${JSON.stringify(Object.keys(sqs))}`);
  console.log(`sqs.queues keys = ${JSON.stringify(Object.keys(sqs.queues))}`);
  // console.log(`sqs.queues = ${JSON.stringify(sqs.queues)}`);
  console.log(`sqs.endpoints = ${JSON.stringify(sqs.endpoints)}`);
  await sqs.createSQSClient(ctx, qConfig);
  console.log(`sqs keys = ${JSON.stringify(Object.keys(sqs))}`);
  console.log(`sqs.queues keys = ${JSON.stringify(Object.keys(sqs.queues))}`);
  console.log(`sqs.queues.testQueue keys = ${JSON.stringify(Object.keys(sqs.queues.testQueue))}`);
  // console.log(`sqs.queues = ${JSON.stringify(sqs.queues)}`);
  console.log(`sqs.endpoints = ${JSON.stringify(sqs.endpoints)}`);
  console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%');
  await sqs.subscribe(ctx, 'testQueue', () => {}, {});
  console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% SQS Client Starting');
  await sqs.start(ctx);
  console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% SQS Client Started');
  console.log(`sqs keys = ${JSON.stringify(Object.keys(sqs))}`);
  console.log(`sqs.queues keys = ${JSON.stringify(Object.keys(sqs.queues))}`);
  console.log(`sqs.queues.testQueue keys = ${JSON.stringify(Object.keys(sqs.queues.testQueue))}`);

});

test('Test recieve message', async () => {
  const sqs = new SqsClient(ctx, qConfig);
  console.log(`sqs keys = ${JSON.stringify(Object.keys(sqs))}`);
  console.log(`sqs.queues keys = ${JSON.stringify(Object.keys(sqs.queues))}`);
  // console.log(`sqs.queues = ${JSON.stringify(sqs.queues)}`);
  console.log(`sqs.endpoints = ${JSON.stringify(sqs.endpoints)}`);
  await sqs.createSQSClient(ctx, qConfig);
  const message = await sqs.recieveMessage(ctx, 'testQueue');
  console.log(`message = ${JSON.stringify(message)}`);

});
