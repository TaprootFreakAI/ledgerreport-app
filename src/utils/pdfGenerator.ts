import { buildWalletBalancePdf, type ReportParams } from "../core/pdf";

// Browser entry point: builds the report (src/core/pdf.ts, shared with the
// headless CLI) and triggers the download.
export const generateWalletBalancePDF = async (params: ReportParams): Promise<void> => {
  const doc = await buildWalletBalancePdf(params);
  // Filename keeps ISO YYYY-MM-DD because that's the right call for sortable
  // filenames; the on-page Date row uses Swiss formatting to match the form
  // input.
  doc.save(`wallet-balance-${params.formData.date}.pdf`);
};
