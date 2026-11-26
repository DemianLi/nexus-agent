import { MODEL_DOES_NOT_SUPPORT_IMAGES } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { attachmentRejectionText, sendRejectionText } from '@/shared/connection/send-rejection';

describe('attachmentRejectionText', () => {
  it('模型不收圖與伺服器不收附件換成給人看的話；不認得的碼回 undefined', () => {
    expect(attachmentRejectionText(MODEL_DOES_NOT_SUPPORT_IMAGES)).toContain('目前的模型不收圖片');
    expect(attachmentRejectionText('not_supported')).toBe('這個伺服器不收附件。');
    expect(attachmentRejectionText('invalid_argument')).toBeUndefined();
    expect(attachmentRejectionText(undefined)).toBeUndefined();
  });
});

describe('sendRejectionText', () => {
  it('沒點名時照附件的話（模型不收圖、不收附件、別的碼用伺服器自己的訊息）', () => {
    expect(sendRejectionText(MODEL_DOES_NOT_SUPPORT_IMAGES, true, false)).toContain('不收圖片');
    expect(sendRejectionText('not_supported', true, false)).toBe('這個伺服器不收附件。');
    expect(sendRejectionText('invalid_argument', false, false)).toBeUndefined();
  });

  it('只點名子代理被拒 not_supported：說的是子代理，不誤說不收附件', () => {
    expect(sendRejectionText('not_supported', false, true)).toBe(
      '這個伺服器不收點名子代理：取消標記再送。',
    );
  });

  it('附件與點名都帶時分不出是哪個不收：用伺服器自己的訊息', () => {
    expect(sendRejectionText('not_supported', true, true)).toBeUndefined();
  });

  it('點名時別的碼照舊：名字不在清單上用伺服器的訊息，模型不收圖仍說圖', () => {
    expect(sendRejectionText('invalid_argument', false, true)).toBeUndefined();
    expect(sendRejectionText(MODEL_DOES_NOT_SUPPORT_IMAGES, true, true)).toContain('不收圖片');
  });
});
