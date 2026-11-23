/**
 * `run.start` 被伺服器拒絕時，給使用者看的那一句：附件與點名子代理兩類錯誤碼換成人話。
 *
 * @module
 */

import { MODEL_DOES_NOT_SUPPORT_IMAGES } from '@nexus/wire';

/** 伺服器收下那一句之後回的錯誤碼，換成給人看的話；不認得的碼回 `undefined`（用伺服器自己的訊息）。 */
export function attachmentRejectionText(code: string | undefined): string | undefined {
  if (code === MODEL_DOES_NOT_SUPPORT_IMAGES) {
    return '目前的模型不收圖片：換一顆能看圖的模型，或把圖片移掉再送。';
  }
  if (code === 'not_supported') return '這個伺服器不收附件。';
  return undefined;
}

/**
 * `run.start` 被拒時的話：附件的兩種碼照上面；`not_supported` 要看這句帶了什麼——只點名子代理時說的是子代理
 * （不然會誤說「不收附件」），附件與點名都帶就用伺服器自己的訊息（分不出是哪一個）。
 */
export function sendRejectionText(
  code: string | undefined,
  hasAttachments: boolean,
  hasMention: boolean,
): string | undefined {
  if (code === 'not_supported' && hasMention) {
    return hasAttachments ? undefined : '這個伺服器不收點名子代理：取消標記再送。';
  }
  return attachmentRejectionText(code);
}
