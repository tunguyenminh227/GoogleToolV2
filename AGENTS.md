# Quy tắc phát triển GoogleTool

## Log trace bắt buộc

- Tất cả hàm viết mới hoặc chỉnh sửa phải có `trace in` ở đầu và `trace out` khi kết thúc. Áp dụng cả hàm đồng bộ, bất đồng bộ và callback xử lý nghiệp vụ.
- `trace out` phải được ghi đúng một lần trên mọi đường thoát: thành công, return sớm hoặc exception. Dùng `try/catch/finally` hoặc wrapper trace dùng chung; với async phải chờ công việc hoàn tất trước khi ghi out.
- Log cần có thời gian, tên hàm, mã lần gọi để ghép in/out, thời lượng và trạng thái thành công/lỗi. Mục đích: người dùng và agent cùng dò log để tìm lỗi.
- Log của profile nào phải ghi riêng cho profile đó: `logs/profiles/<profileId>/trace-YYYY-MM-DD.jsonl`, kèm `profileId` trong mỗi dòng. Log chung ghi ở `logs/app/`. Dùng ngữ cảnh async `trace.withProfile` hoặc tùy chọn `profileArgument` của `trace.traced` để giữ đúng profile qua các lời gọi lồng nhau/chạy đồng thời. Không dùng tên/email để tạo đường dẫn log. Tác vụ tạo mới chưa có ID và tác vụ toàn app ghi log chung.
- Dùng bộ log `v2/trace-log.js` trong main process. Không tự ghi mật khẩu, recovery mail, khóa/mã Authenticator, cookie, token, nội dung form, tham số IPC hay toàn bộ URL có query vào log. Chỉ ghi tên hàm/sự kiện cố định và mã lỗi an toàn; không tự serialize arguments/results/errors.
- Các hàm nền của chính bộ ghi log không tự gọi trace để tránh đệ quy vô hạn. Đây là ngoại lệ kỹ thuật dành riêng cho logger, không dành cho hàm nghiệp vụ.
- Quy tắc áp dụng từ thay đổi này trở đi; khi sửa hàm cũ phải bổ sung trace. Không tuyên bố toàn bộ hàm cũ đã được instrument nếu chưa thực hiện.

## Luồng Login gmail

1. Sau khi nhập Gmail / password / recovery mail / Authenticator và bấm **Next / Tiếp tục**, không sử dụng hàm đợi theo thời gian cố định hoặc `sleep` để chuyển bước.
2. Đăng ký theo dõi sự kiện thay đổi URL **trước khi bấm nút**, tránh bỏ lỡ chuyển trang nhanh. Chờ URL đổi so với URL trước thao tác; sau đó mới phân nhánh các trường hợp tiếp theo.
3. Áp dụng cho từng bước nhập nêu trên. Không dùng vòng polling kèm sleep để đoán trang đã sẵn sàng. Timeout chỉ là giới hạn để báo lỗi/hủy theo dõi, không phải điều kiện chuyển sang bước kế tiếp.
4. Nếu URL không đổi hoặc gặp lỗi, không tự coi bước đã thành công. Ghi trace trạng thái lỗi/timeout an toàn để chẩn đoán; không ghi thông tin đăng nhập.
5. `Login gmail` đã có logic ở `v2/gmail-login.js`.
6. Khi nhập Gmail, password, recovery mail, mã Authenticator và các trường thông tin khác trong luồng Login gmail, phải nhập từng ký tự với độ trễ giữa các ký tự; không điền toàn bộ chuỗi tức thời. Độ trễ cần cấu hình được. Quy tắc này chỉ áp dụng trong lúc gõ; sau khi bấm **Next / Tiếp tục** vẫn phải chờ sự kiện URL thay đổi theo các mục trên, không dùng sleep để chuyển bước. Không ghi ký tự hoặc giá trị đang nhập vào log.

## Luồng Verify Google Ads

- Khi tìm thấy tài khoản trong danh sách tìm kiếm (account picker), **KHÔNG sử dụng** link dạng `/aw/billing/advertiserverification?ocid=...` hoặc `actionUrl` tùy chỉnh.
- Mở chính xác link của tài khoản (link overview của tài khoản trả về từ kết quả tìm kiếm `foundAccount.href` hoặc mở link in new window).
- Cửa sổ tài khoản mở ra ở window mới và được tự động sắp xếp theo hàng ngang có cùng kích thước như window chính. Không chia đôi màn hình và không thay đổi kích thước của window chính.

## Tự động khởi động lại app sau khi code

- Sau khi hoàn thành việc viết code, chỉnh sửa hoặc sửa lỗi, agent phải tự động tắt các tiến trình app đang chạy và khởi động lại app bằng `start.bat` (`Start-Process -FilePath "c:\Users\TU\OneDrive\Desktop\GoogleTool\start.bat"`) để áp dụng ngay các thay đổi mới nhất.

