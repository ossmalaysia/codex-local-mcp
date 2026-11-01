using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexLocalMCP {
  static class SetupEntry {
    static string Option(string[] args,string name) { int index=Array.IndexOf(args,name); return index>=0 && index+1<args.Length ? args[index+1] : null; }
    [STAThread] static int Main(string[] args) {
      bool uninstall=Assembly.GetExecutingAssembly().GetManifestResourceInfo("Payload.zip")==null;
      bool silent=args.Contains("--silent");
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      try {
        if(!Environment.Is64BitOperatingSystem) throw new PlatformNotSupportedException("Codex Local MCP requires 64-bit Windows.");
        string test=Option(args,"--test-id");
        if (test!=null && !System.Text.RegularExpressions.Regex.IsMatch(test,"^[a-f0-9]{32}$")) throw new ArgumentException("Invalid setup test identifier.");
        string target=Option(args,"--target") ?? SetupEngine.DefaultDirectory;
        string record=Option(args,"--record") ?? Path.Combine(SetupEngine.DataDirectory,"install.json");
        if (args.Contains("--self-test")) { SetupEngine.CheckResources(); return 0; }
        using (var mutex=new Mutex(false,@"Local\CodexLocalMCPSetup-"+WindowsIdentity.GetCurrent().User.Value)) {
          bool acquired=false; try { acquired=mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired=true; }
          if (!acquired) throw new IOException("Another setup or uninstall is running. Finish it before trying again.");
          try {
            if (silent) {
              if (uninstall) SetupEngine.Uninstall(record,null);
              else SetupEngine.Install(target,test,!args.Contains("--no-shortcuts"),null,CancellationToken.None);
              return 0;
            }
            using (var form=new SetupWindow(uninstall,target,record,test)) {
              if (args.Length==2 && args[0]=="--render-preview") {
                form.ShowInTaskbar=false; form.StartPosition=FormStartPosition.Manual; form.Location=new Point(-32000,-32000); form.Show(); Application.DoEvents();
                using (var bitmap=new Bitmap(form.Width,form.Height)) { form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,form.Size)); bitmap.Save(args[1]); }
                form.Close(); return 0;
              }
              Application.Run(form); return form.Completed ? 0 : 1602;
            }
          } finally { mutex.ReleaseMutex(); }
        }
      } catch(Exception error) {
        if (silent) Console.Error.WriteLine(error.ToString());
        else MessageBox.Show(error.Message,"Codex Local MCP Setup",MessageBoxButtons.OK,MessageBoxIcon.Error);
        return 1;
      }
    }
  }
  sealed class SetupWindow : Form {
    readonly bool uninstall; readonly string record,test;
    readonly TextBox location=new TextBox(); readonly Label status=new Label(); readonly ProgressBar progress=new ProgressBar();
    readonly Button action=new Button(),cancel=new Button(),browse=new Button();
    readonly CheckBox launch=new CheckBox { Text="Open Codex Local MCP when setup finishes",Checked=true,AutoSize=true };
    readonly CancellationTokenSource cancellation=new CancellationTokenSource();
    bool working;
    internal bool Completed { get; private set; }
    internal SetupWindow(bool remove,string directory,string recordPath,string testId) {
      uninstall=remove; record=recordPath; test=testId;
      var version=FileVersionInfo.GetVersionInfo(Assembly.GetExecutingAssembly().Location).ProductVersion.Split('+')[0];
      Text="Codex Local MCP "+(remove?"Uninstall":"Setup"); ClientSize=new Size(660,460); FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false;
      StartPosition=FormStartPosition.CenterScreen; Font=new Font("Segoe UI",10); BackColor=Color.White; ForeColor=Color.FromArgb(27,35,49);
      Icon=Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
      using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("CodexLocalMCP.logo.png")) using(var image=Image.FromStream(stream))
        Controls.Add(new PictureBox { Image=new Bitmap(image),Location=new Point(30,30),Size=new Size(56,56),SizeMode=PictureBoxSizeMode.Zoom });
      Controls.Add(new Label { Text=remove?"Uninstall Codex Local MCP":"Install Codex Local MCP",Font=new Font("Segoe UI",21,FontStyle.Bold),AutoSize=true,Location=new Point(104,28) });
      Controls.Add(new Label { Text="Version "+version+"  ·  Windows x64",AutoSize=true,ForeColor=Color.FromArgb(92,105,124),Location=new Point(108,70) });
      var description=remove?"This removes application files and shortcuts.\nYour saved login, settings, and workspaces will remain.":"Set up your secure connection between Claude and this PC.\nSetup includes the app, Codex, and Cloudflare Tunnel.";
      Controls.Add(new Label { Text=description,Location=new Point(32,115),Size=new Size(595,54) });
      Controls.Add(new Label { Text=remove?"Your data stays on this PC.":"Installation folder",AutoSize=true,Location=new Point(32,186) });
      location.Text=directory; location.Location=new Point(32,214); location.Size=new Size(485,28); location.ReadOnly=true; location.AccessibleName="Installation folder";
      browse.Text="Change…"; browse.Location=new Point(527,209); browse.Size=new Size(100,36);
      browse.Click+=(s,e)=>{ using(var picker=new FolderBrowserDialog { Description="Choose a dedicated installation folder",SelectedPath=location.Text }) if(picker.ShowDialog(this)==DialogResult.OK) location.Text=picker.SelectedPath; };
      if(!remove) Controls.AddRange(new Control[]{location,browse});
      launch.Location=new Point(32,263); launch.Visible=!remove; Controls.Add(launch);
      status.Text=remove?"Select Uninstall to remove the app.":"Ready to install for your Windows account."; status.Location=new Point(32,310); status.Size=new Size(595,43); status.AutoEllipsis=true; Controls.Add(status);
      progress.Location=new Point(32,357); progress.Size=new Size(595,12); Controls.Add(progress);
      action.Text=remove?"Uninstall":"Install"; action.Location=new Point(491,395); action.Size=new Size(136,42); action.BackColor=Color.FromArgb(77,70,215); action.ForeColor=Color.White; action.FlatStyle=FlatStyle.Flat; action.FlatAppearance.BorderSize=0;
      cancel.Text="Cancel"; cancel.Location=new Point(369,395); cancel.Size=new Size(112,42); cancel.FlatStyle=FlatStyle.Flat; cancel.FlatAppearance.BorderColor=Color.FromArgb(216,220,232);
      Controls.AddRange(new Control[]{action,cancel}); AcceptButton=action; CancelButton=cancel;
      cancel.Click+=(s,e)=>{ if(working) { cancellation.Cancel(); status.Text="Cancelling setup…"; } else Close(); };
      action.Click+=async(s,e)=>await Run();
      FormClosing+=(s,e)=>{ if(working){ e.Cancel=true; if(uninstall) status.Text="Please wait for uninstall to finish."; else { cancellation.Cancel(); status.Text="Cancelling setup…"; } } };
    }
    async Task Run() {
      if(Completed) { if(!uninstall && launch.Checked) try { Process.Start(UpdateInstaller.CleanProcess(Path.Combine(location.Text,"CodexMCP.exe"),"")); } catch(Exception error) { MessageBox.Show(this,"Setup is complete. Open Codex Local MCP from the Start menu. "+error.Message,Text); } Close(); return; }
      working=true; action.Enabled=false; browse.Enabled=false; launch.Enabled=false; cancel.Enabled=!uninstall;
      string directory=location.Text;
      var updates=new Progress<Tuple<int,string>>(value=>{ if(!IsDisposed) { progress.Value=value.Item1; status.Text=value.Item2; if(value.Item1>=92) cancel.Enabled=false; } });
      try {
        if(uninstall) await Task.Run(()=>SetupEngine.Uninstall(record,updates));
        else await Task.Run(()=>SetupEngine.Install(directory,test,true,updates,cancellation.Token));
        Completed=true; action.Text="Finish"; cancel.Visible=false; launch.Enabled=true;
      } catch(OperationCanceledException) { status.Text="Setup was cancelled. Your settings and workspaces were kept."; cancel.Text="Close"; }
      catch(Exception error) { status.Text=error.Message; MessageBox.Show(this,error.Message,Text,MessageBoxButtons.OK,MessageBoxIcon.Error); }
      finally { working=false; action.Enabled=Completed || !cancellation.IsCancellationRequested; browse.Enabled=!Completed; cancel.Enabled=true; }
    }
  }
}
