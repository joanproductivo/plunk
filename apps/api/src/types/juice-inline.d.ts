// juice ships types for its main entry only. emailBody.ts uses its inliner core directly.
declare module 'juice/lib/inline.js' {
  import type {CheerioAPI} from 'cheerio/slim';

  interface InlineOptions {
    applyWidthAttributes?: boolean;
    applyHeightAttributes?: boolean;
    applyAttributesTableElements?: boolean;
  }

  interface JuiceInlineClient {
    inlineDocument($: CheerioAPI, css: string, options?: InlineOptions): void;
  }

  export default function makeJuiceClient(base: object): JuiceInlineClient;
}
