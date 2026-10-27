// AWS Transcribe: listed so people looking for it find it, not usable yet. its batch API reads
// audio only from an S3 bucket and every request needs SigV4 signing, which is more than a plain
// key field can do without the AWS SDK
//   https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartTranscriptionJob.html
import { SttError } from './http'
import type { SttProvider } from './types'

export const aws: SttProvider = {
  id: 'aws-transcribe',
  label: 'AWS Transcribe',
  kind: 'api',
  fields: [],
  defaultModel: 'default',
  staticModels: [],
  supportsWordTimestamps: true,
  supportsStreaming: false,
  unavailable: 'Coming later. AWS Transcribe needs an S3 bucket and signed requests.',
  docsUrl: 'https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartTranscriptionJob.html',
  host: () => '',
  transcribe() {
    return Promise.reject(new SttError('AWS Transcribe is not available yet.'))
  }
}
