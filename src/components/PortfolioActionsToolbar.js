import React, { useState } from 'react';
import PageToolbar, { ToolbarButton, ToolbarPrimaryButton, ToolbarStatus } from './PageToolbar';
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
  // Pages with no editable table (the overview) hide the edit-mode and
  // extra-columns toggles - there is nothing on them for either to act on.
  showTableControls = true,
  // Passed straight through to PageToolbar - see its note on why the
  // dashboard's header is the one that does not pin.
  sticky = true
}) {
  const [exportError, setExportError] = useState('');

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

  const handleExportPdf = async () => {
    setExportError('');
    try {
      // The report's sector donut needs each US ticker's sector, which only
      // the analysis page loads; and its cover says when prices were taken.
      const report = await import('../utils/exportReport');
      const [sectorBySymbol, logo] = await Promise.all([
        loadStockSectors((exportPortfolioData.americanStocks || []).map((s) => s.stockName)),
        report.loadReportLogo ? report.loadReportLogo() : null
      ]);
      report.downloadPortfolioPdf({ ...exportPortfolioData, sectorBySymbol, pricesAsOf: pricesLastRefreshAt, logo });
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
          <ToolbarButton onClick={handleExportPdf} title="ייצוא הטבלאות ל-PDF">
            ייצוא PDF
          </ToolbarButton>
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
  const primaryAction = (
    <>
      <ToolbarPrimaryButton onClick={handleAddInfo}>+ הוספת מידע</ToolbarPrimaryButton>
      <ToolbarButton
        onClick={savePortfolio}
        disabled={!hasUnsavedChanges || saveLoading}
        pressed={hasUnsavedChanges}
      >
        {saveLoading ? 'שומר…' : hasUnsavedChanges ? 'שמור שינויים' : 'נשמר'}
      </ToolbarButton>
    </>
  );

  const status = (
    <>
      {hasAnyData && (
        <span className={`price-refresh-status ${pricesRefreshing ? 'is-refreshing' : ''}`}>
          <span className="price-refresh-dot" />
          {pricesRefreshing
            ? hasLoadedLivePrices
              ? 'מעדכן מחירים…'
              : 'טוען מחירים עדכניים…'
            : pricesLastRefreshAt
            ? `מחירים עודכנו ב-${pricesLastRefreshAt.toLocaleTimeString('he-IL')}`
            : 'מוצגים מחירים אחרונים שנשמרו'}
        </span>
      )}
      {lastSavedAt && (
        <ToolbarStatus>נשמר לאחרונה: {lastSavedAt.toLocaleTimeString('he-IL')}</ToolbarStatus>
      )}
      {lastSnapshotSavedAt && (
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
      secondaryActions={secondaryActions}
      status={status}
      sticky={sticky}
    />
  );
}

export default PortfolioActionsToolbar;
