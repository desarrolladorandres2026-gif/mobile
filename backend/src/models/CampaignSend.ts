import { realtimeInvalidatePlugin } from '../realtime/invalidate';
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Historial de envíos dirigidos.
 *
 * Un push masivo no se puede deshacer, así que hay que poder reconstruir
 * quién mandó qué, a qué segmento y cuánto llegó. El registro nace en
 * `sending` antes de mandar nada: eso sirve a la vez de bitácora y de
 * candado (no se lanzan dos envíos a la vez).
 */
export type CampaignSendStatus = 'sending' | 'done' | 'failed';

export interface ICampaignSend extends Document {
  sentBy: Types.ObjectId;
  segment: Record<string, unknown>;
  title: string;
  body: string;
  status: CampaignSendStatus;
  targeted: number;
  sent: number;
  failed: number;
  finishedAt: Date | null;
  createdAt: Date;
}

const campaignSendSchema = new Schema<ICampaignSend>(
  {
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    segment: { type: Schema.Types.Mixed, default: {} },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    body: { type: String, required: true, trim: true, maxlength: 240 },
    status: { type: String, enum: ['sending', 'done', 'failed'], default: 'sending', index: true },
    targeted: { type: Number, default: 0, min: 0 },
    sent: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

campaignSendSchema.index({ createdAt: -1 });

campaignSendSchema.plugin(realtimeInvalidatePlugin, { resource: 'campaigns' });
export const CampaignSend = mongoose.model<ICampaignSend>('CampaignSend', campaignSendSchema);
