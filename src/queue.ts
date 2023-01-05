export async function getQueue(config: SQSQueueConfiguration) {
  const { name } = config;
  const localName = config.logicalName || name;

}
