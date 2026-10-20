import React, { useState } from 'react';
import PageToolbar, { ToolbarButton, ToolbarMoreMenu, ToolbarPrimaryButton, ToolbarStatus } from './PageToolbar';
import { useCompactLayout } from '../hooks/useMediaQuery';
import { loadStockSectors } from '../hooks/useStockSectors';

// The controls that act on the portfolio itself - add, save, edit mode,
// extra columns, export - plus the save/price status line.
//
// Extracted from HomeView because the holdings tables no longer live on one
// page. Each asset page owns an editable table, so each needs the same edit
// mode toggle, the same save button and the same "prices are refreshing"
// indicator; without this they would be copied five times and drift apart.
//
// `title` and `subtitle` are per page. Everything else is the shared
// portfolio state passed straight through from App.js.
// "14:32" for a price from today, "18.10 14:32" for an older one.
function formatStaleTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} ${time}`;
}

function PortfolioActionsToolbar({
  title,
  subtitle,
  showLegacyImportButton,
  legacyImportLoading,
  handleLegacyImportOnce,
  savePortfolio,
  hasUnsavedChanges,
  saveLoading,
  lastSavedAt,
  saveError,
  snapshotSaveError,
  lastSnapshotSavedAt,
  legacyImportBanner,
  handleAddInfo,
  isEditMode,
  setIsEditMode,
  showAmericanColumns,
  setShowAmericanColumns,
  hasAnyData,
  exportPortfolioData,
  // Background price-refresh progress (see usePriceRefresh.js). The tables
  // render immediately from the prices saved with the portfolio; these tell
  // the user whether newer ones are still being fetched, so a stale number
  // is never silently presented as live.
  pricesRefreshing = false,
  pricesLastRefreshAt = null,
  hasLoadedLivePrices = false,
  // Holdings whose price is not current (usePriceRefresh.js's
  // findStalePrices): [{ symbol, name, fetchedAt }].
  stalePrices = [],
  // Pages with no editable table (the overview) hide the edit-mode and
  // extra-columns toggles - there is nothing on them for either to act on.
  showTableControls = true,
  // Passed straight through to PageToolbar - see its note on why the
  // dashboard's header is the one that does not pin.
  sticky = true
}) {
  const [exportError, setExportError] = useState('');
  // On a phone: one row - the primary action, a "⋯" menu with the rest,
  // and save only while there is something to save.
  const compact = useCompactLayout();

  // exportReport.js pulls in exceljs + jsPDF + the embedded Hebrew font -
  // several hundred KB gzipped (confirmed: it blew up the main bundle by
  // ~458KB when imported statically). Loaded on demand here instead, so
  // that weight only hits users who actually click export, not everyone
  // who opens their portfolio.
  const handleExportExcel = async () => {
    setExportError('');
    try {
      const { downloadPortfolioExcel } = await import('../utils/exportReport');
      await downloadPortfolioExcel(exportPortfolioData);
    } catch {
      setExportError('שגיאה בייצוא לאקסל, נסה שוב');
    }
  };

  // reportMode: 'summary' (one row per stock) or 'detailed' (every
  // purchase) - see exportReport.js's PDF_REPORT_MODES.
  const handleExportPdf = async (reportMode) => {
    setExportError('');
    try {
      // The report's sector donut needs each US ticker's sector, which only
      // the analysis page loads; and its cover says when prices were taken.
      const report = await import('../utils/exportReport');
      const [sectorBySymbol, logo] = await Promise.all([
        loadStockSectors((exportPortfolioData.americanStocks || []).map((s) => s.stockName)),
        report.loadReportLogo ? report.loadReportLogo() : null
      ]);
      report.downloadPortfolioPdf({ ...exportPortfolioData, sectorBySymbol, pricesAsOf: pricesLastRefreshAt, logo, reportMode });
    } catch {
      setExportError('שגיאה בייצוא ל-PDF, נסה שוב');
    }
  };

  // Every control that acts on this page, in one strip, split by weight:
  // one filled primary action, and a quiet cluster of view/export
  // secondaries.
  const secondaryActions = (
    <>
      {showTableControls && (
        <>
          <ToolbarButton
            onClick={() => setIsEditMode(!isEditMode)}
            pressed={isEditMode}
            title="עריכת תאים ישירות בטבלאות"
          >
            {isEditMode ? '✓ מצב עריכה' : 'מצב עריכה'}
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setShowAmericanColumns(!showAmericanColumns)}
            pressed={showAmericanColumns}
            title="עמודות מס, מדד ורווח ריאלי"
          >
            נתונים מורחבים
          </ToolbarButton>
        </>
      )}
      {hasAnyData && (
        <>
          <ToolbarButton onClick={handleExportExcel} title="ייצוא הטבלאות לאקסל">
            ייצוא Excel
          </ToolbarButton>
          {/* Two reports. Inside the phone's "⋯" menu a menu cannot open
              another, so there the two are plain items of it. */}
          {compact ? (
            <>
              <ToolbarButton onClick={() => handleExportPdf('summary')} title="שורה אחת לכל מניה">
                PDF מקוצר
              </ToolbarButton>
              <ToolbarButton onClick={() => handleExportPdf('detailed')} title="כל קנייה בשורה נפרדת">
                PDF מפורט
              </ToolbarButton>
            </>
          ) : (
            <ToolbarMoreMenu
              label="ייצוא הטבלאות ל-PDF"
              trigger={
                <>
                  ייצוא PDF <span aria-hidden="true">▾</span>
                </>
              }
            >
              <button type="button" className="pdf-choice" onClick={() => handleExportPdf('summary')}>
                <span className="pdf-choice-title">דוח מקוצר</span>
                <span className="pdf-choice-desc">כל מניה בשורה אחת - כמות וסכום כולל</span>
              </button>
              <button type="button" className="pdf-choice" onClick={() => handleExportPdf('detailed')}>
                <span className="pdf-choice-title">דוח מפורט</span>
                <span className="pdf-choice-desc">כל קנייה בשורה נפרדת, עם תאריך ומחיר</span>
              </button>
            </ToolbarMoreMenu>
          )}
        </>
      )}
      {showLegacyImportButton && (
        <ToolbarButton onClick={handleLegacyImportOnce} disabled={legacyImportLoading}>
          {legacyImportLoading ? 'מייבא…' : 'ייבוא מהדפדפן'}
        </ToolbarButton>
      )}
    </>
  );

  // Save is the primary action only while there is something to save;
  // otherwise it states that everything is saved and stays out of the way.
  const showSave = !compact || hasUnsavedChanges || saveLoading;
  const primaryAction = (
    <>
      <ToolbarPrimaryButton onClick={handleAddInfo}>+ הוספת מידע</ToolbarPrimaryButton>
      {showSave && (
        <ToolbarButton
          onClick={savePortfolio}
          disabled={!hasUnsavedChanges || saveLoading}
          pressed={hasUnsavedChanges}
        >
          {saveLoading ? 'שומר…' : hasUnsavedChanges ? 'שמור שינויים' : 'נשמר'}
        </ToolbarButton>
      )}
      {compact && <ToolbarMoreMenu>{secondaryActions}</ToolbarMoreMenu>}
    </>
  );

  // "Prices updated at 14:32" used to be shown after every cycle, even one
  // in which a source had failed and nothing was updated - so an old price
  // looked live. When some prices are not current, the status says how
  // many, and its tooltip names each one with the time it is from.
  const staleCount = stalePrices.length;
  const staleTitle = staleCount
    ? stalePrices
        .map((p) => `${p.name}: ${p.fetchedAt ? `מחיר מ-${formatStaleTime(p.fetchedAt)}` : 'מחיר אחרון שנשמר'}`)
        .join('\n')
    : undefined;

  const status = (
    <>
      {hasAnyData && (
        <span
          className={`price-refresh-status ${pricesRefreshing ? 'is-refreshing' : ''} ${!pricesRefreshing && staleCount ? 'is-stale' : ''}`}
          title={!pricesRefreshing ? staleTitle : undefined}
        >
          <span className="price-refresh-dot" />
          {pricesRefreshing
            ? hasLoadedLivePrices
              ? 'מעדכן מחירים…'
              : 'טוען מחירים עדכניים…'
            : staleCount
            ? `${staleCount === 1 ? 'מחיר אחד לא התעדכן' : `${staleCount} מחירים לא התעדכנו`} - מוצג המחיר האחרון הידוע`
            : pricesLastRefreshAt
            ? `מחירים עודכנו ב-${pricesLastRefreshAt.toLocaleTimeString('he-IL')}`
            : 'מוצגים מחירים אחרונים שנשמרו'}
        </span>
      )}
      {/* Where the prices come from and what they are not for - next to the
          prices themselves, not only in the terms (section 5). */}
      {hasAnyData && <ToolbarStatus>מחירים ממקורות ציבוריים, ייתכן עיכוב · למידע בלבד, לא לצורכי מסחר</ToolbarStatus>}
      {lastSavedAt && !compact && (
        <ToolbarStatus>נשמר לאחרונה: {lastSavedAt.toLocaleTimeString('he-IL')}</ToolbarStatus>
      )}
      {lastSnapshotSavedAt && !compact && (
        <ToolbarStatus>מידע יומי נשמר: {lastSnapshotSavedAt.toLocaleTimeString('he-IL')}</ToolbarStatus>
      )}
      {saveError && <ToolbarStatus tone="negative">{saveError}</ToolbarStatus>}
      {snapshotSaveError && <ToolbarStatus tone="negative">{snapshotSaveError}</ToolbarStatus>}
      {exportError && <ToolbarStatus tone="negative">{exportError}</ToolbarStatus>}
      {legacyImportBanner && <ToolbarStatus tone="positive">{legacyImportBanner}</ToolbarStatus>}
    </>
  );

  return (
    <PageToolbar
      title={title}
      subtitle={subtitle}
      primaryAction={primaryAction}
      secondaryActions={compact ? null : secondaryActions}
      status={status}
      sticky={sticky}
    />
  );
}

export default PortfolioActionsToolbar;
